import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { cashAvailabilityForDate, round2 } from "../lib/clinic-day.js";
import { employeeNameMap, mapCashWithdrawal } from "../lib/cash-withdrawal.js";
import { logAudit, todayStr } from "../lib/utils.js";
import { resolveEmployeeId } from "../lib/resolve-employee.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireAdmin, requireStaff } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createWithdrawalSchema,
  rejectWithdrawalSchema,
  reviewWithdrawalSchema,
} from "../schemas/withdrawals.js";

const router = Router();
const log = logger.child({ module: "routes/cash-withdrawals" });
const STATUSES = ["pending", "approved", "rejected"];

const fail = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

function denyClientSession(req, res, next) {
  const auth = String(req.headers.authorization ?? "");
  if (auth.startsWith("Bearer ") && !auth.slice(7).includes(".")) {
    return res.status(403).json({ error: "Forbidden — staff access only" });
  }
  return next();
}

function respondWithError(res, err, fallbackMessage) {
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600) {
    const { status, message, ...extra } = err;
    return res.status(status).json({ error: message, ...extra });
  }
  log.error({ err }, fallbackMessage);
  return res.status(500).json({ error: fallbackMessage });
}

/** Serialize concurrent requests/approvals for one Cairo day. */
async function lockCashDay(tx, date) {
  if (typeof tx.$queryRaw === "function") {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${"cash-withdrawal:" + date}))`;
  }
}

async function employeeNames() {
  const employees = await prisma.employee.findMany({
    select: { id: true, fullName: true },
  });
  return employeeNameMap(employees);
}

const includeRelations = {
  requester: { select: { id: true, username: true } },
  reviewer: { select: { id: true, username: true } },
};

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

router.get("/", denyClientSession, authenticateUser, requireStaff, async (req, res) => {
  const date = String(req.query.date ?? todayStr());
  const status = String(req.query.status ?? "all");
  if (!isValidDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  if (status !== "all" && !STATUSES.includes(status)) {
    return res.status(400).json({ error: "Invalid status filter" });
  }
  try {
    const where = {
      date,
      ...(status === "all" ? {} : { status }),
      // Staff can only ever see their own requests; admin/payroll see the queue.
      ...(req.user.role === "staff" ? { requestedBy: req.user.id } : {}),
    };
    const [rows, names, availability] = await Promise.all([
      prisma.cashWithdrawal.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: includeRelations,
      }),
      employeeNames(),
      cashAvailabilityForDate(prisma, date),
    ]);
    res.json({
      date,
      available: availability.available,
      expected: availability.expected,
      counted: availability.counted,
      openingAmount: availability.openingAmount,
      reserved: availability.reserved,
      close: availability.close,
      withdrawals: rows.map((row) => mapCashWithdrawal(row, names)),
    });
  } catch (err) {
    respondWithError(res, err, "Failed to load withdrawal requests");
  }
});

router.post(
  "/",
  denyClientSession,
  authenticateUser,
  requireStaff,
  validate(createWithdrawalSchema),
  async (req, res) => {
    const { amount, note } = req.validated.body;
    const date = req.validated.body.date ?? todayStr();
    const value = round2(amount);
    try {
      const employeeId = await resolveEmployeeId(req.user.id);
      if (!employeeId) {
        return res.status(400).json({ error: "No employee profile found for your account." });
      }
      const [openSession, names] = await Promise.all([
        prisma.workSession.findFirst({
          where: { employeeId, endedAt: null },
          orderBy: { startedAt: "desc" },
        }),
        employeeNames(),
      ]);

      const result = await prisma.$transaction(async (tx) => {
        await lockCashDay(tx, date);
        const availability = await cashAvailabilityForDate(tx, date, { includePending: true });
        if (value > availability.available) {
          throw fail(409, "Insufficient cash is available in the system.", {
            available: availability.available,
          });
        }
        const created = await tx.cashWithdrawal.create({
          data: {
            date,
            amount: value,
            note,
            status: "pending",
            requestedBy: req.user.id,
            employeeId,
            workSessionId: openSession?.id ?? null,
          },
          include: includeRelations,
        });
        return {
          created,
          available: round2(Math.max(0, availability.available - value)),
        };
      }, { timeout: 15000 });

      logAudit(
        "cash_withdrawal_requested",
        result.created.id,
        `Withdrawal requested: ${value} on ${date} by staff #${req.user.id} — ${note}`,
      );
      res.status(201).json({
        withdrawal: mapCashWithdrawal(result.created, names),
        available: result.available,
      });
    } catch (err) {
      respondWithError(res, err, "Failed to request withdrawal");
    }
  },
);

router.post(
  "/:id/approve",
  denyClientSession,
  authenticateUser,
  requireAdmin,
  validate(reviewWithdrawalSchema),
  async (req, res) => {
    const { id } = req.validated.params;
    const { note } = req.validated.body;
    try {
      const existing = await prisma.cashWithdrawal.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ error: "Withdrawal request not found" });
      if (existing.status !== "pending") {
        return res.status(409).json({ error: "This withdrawal has already been decided." });
      }

      const result = await prisma.$transaction(async (tx) => {
        await lockCashDay(tx, existing.date);
        const current = await tx.cashWithdrawal.findUnique({ where: { id } });
        if (!current) throw fail(404, "Withdrawal request not found");
        if (current.status !== "pending") {
          throw fail(409, "This withdrawal has already been decided.");
        }
        // The request being decided is no longer a reservation; all other
        // approved withdrawals still reduce what can be paid out.
        const availability = await cashAvailabilityForDate(tx, current.date, {
          includePending: false,
          excludeWithdrawalId: current.id,
        });
        if (current.amount > availability.available) {
          throw fail(409, "Insufficient cash is available in the system.", {
            available: availability.available,
          });
        }
        const updated = await tx.cashWithdrawal.update({
          where: { id },
          data: {
            status: "approved",
            reviewedBy: req.user.id,
            reviewedAt: new Date(),
            reviewNote: note,
          },
          include: includeRelations,
        });
        return {
          updated,
          available: round2(Math.max(0, availability.available - current.amount)),
        };
      }, { timeout: 15000 });

      const names = await employeeNames();
      logAudit(
        "cash_withdrawal_approved",
        id,
        `Withdrawal approved: ${result.updated.amount} on ${existing.date} by staff #${req.user.id}`,
      );
      res.json({
        withdrawal: mapCashWithdrawal(result.updated, names),
        available: result.available,
      });
    } catch (err) {
      respondWithError(res, err, "Failed to approve withdrawal");
    }
  },
);

router.post(
  "/:id/reject",
  denyClientSession,
  authenticateUser,
  requireAdmin,
  validate(rejectWithdrawalSchema),
  async (req, res) => {
    const { id } = req.validated.params;
    const { reason } = req.validated.body;
    try {
      const existing = await prisma.cashWithdrawal.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ error: "Withdrawal request not found" });
      if (existing.status !== "pending") {
        return res.status(409).json({ error: "This withdrawal has already been decided." });
      }
      const updated = await prisma.$transaction(async (tx) => {
        await lockCashDay(tx, existing.date);
        const current = await tx.cashWithdrawal.findUnique({ where: { id } });
        if (!current) throw fail(404, "Withdrawal request not found");
        if (current.status !== "pending") {
          throw fail(409, "This withdrawal has already been decided.");
        }
        return tx.cashWithdrawal.update({
          where: { id },
          data: {
            status: "rejected",
            reviewedBy: req.user.id,
            reviewedAt: new Date(),
            reviewNote: reason,
          },
          include: includeRelations,
        });
      }, { timeout: 15000 });

      const names = await employeeNames();
      logAudit(
        "cash_withdrawal_rejected",
        id,
        `Withdrawal rejected: ${updated.amount} on ${existing.date} by staff #${req.user.id} — ${reason}`,
      );
      res.json({ withdrawal: mapCashWithdrawal(updated, names) });
    } catch (err) {
      respondWithError(res, err, "Failed to reject withdrawal");
    }
  },
);

export default router;
