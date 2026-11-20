import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { logAudit } from "../lib/utils.js";
import { resolveEmployeeId } from "../lib/resolve-employee.js";
import { createBroadcastNotification } from "../lib/notify.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import {
  authenticateUser,
  requireAdmin,
  requireStaff,
  requirePayrollOrAdmin,
} from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  calculatePayrollSchema,
  payrollRecordStatusSchema,
  payrollRecordAmountSchema,
  createPayrollRecordSchema,
  bonusDeductionRequestSchema,
  reviewRequestSchema,
  payrollNotifySchema,
} from "../schemas/payroll.js";

const router = Router();
const log = logger.child({ module: "routes/payroll" });

// Allowed status transitions. Each edge lists the roles that may perform it.
// `calculated` records are drafts; only admins review, approve, or pay a record.
// A rejected record can be reopened as a draft and corrected instead of being
// permanently stuck with no way forward.
const TRANSITIONS = {
  calculated: { pending_approval: ["payroll", "admin"] },
  pending_approval: { approved: ["admin"], rejected: ["admin"] },
  approved: { paid: ["admin"] },
  paid: {},
  rejected: {
    calculated: ["payroll", "admin"],
    pending_approval: ["payroll", "admin"],
  },
};

function isTransitionAllowed(from, to, role) {
  const allowed = TRANSITIONS[from]?.[to];
  return Array.isArray(allowed) && allowed.includes(role);
}

const round2 = (value) => parseFloat(Number(value).toFixed(2));

function netPayFrom(record, updates = {}) {
  return round2(
    (updates.basePay ?? record.basePay ?? 0) +
      (updates.commissionPay ?? record.commissionPay ?? 0) +
      (updates.totalBonuses ?? record.totalBonuses ?? 0) -
      (updates.totalDeductions ?? record.totalDeductions ?? 0),
  );
}

/** Recompute bonus/deduction totals from the approved request set. */
async function recomputeApprovedTotals(recordId, basePay, commissionPay) {
  const approved = await prisma.bonusDeductionRequest.findMany({
    where: { payrollRecordId: recordId, status: "approved" },
  });
  const totalBonuses = approved
    .filter((r) => r.type === "bonus")
    .reduce((sum, r) => sum + r.amount, 0);
  const totalDeductions = approved
    .filter((r) => r.type === "deduction")
    .reduce((sum, r) => sum + r.amount, 0);
  return {
    totalBonuses: round2(totalBonuses),
    totalDeductions: round2(totalDeductions),
    netPay: round2((basePay ?? 0) + (commissionPay ?? 0) + totalBonuses - totalDeductions),
  };
}

// ---- Own payroll (staff can see their own records) ----
router.get("/me", authenticateUser, requireStaff, async (req, res) => {
  try {
    const employeeId = await resolveEmployeeId(req.user.id);
    if (!employeeId) return res.json(paginatedResponse([], 0, parsePagination(req.query)));
    const p = parsePagination(req.query);
    const where = { employeeId };
    if (req.query.status) where.status = String(req.query.status);
    const [records, total] = await Promise.all([
      prisma.payrollRecord.findMany({
        where,
        include: { employee: { select: { id: true, fullName: true, role: true } } },
        orderBy: { periodStart: "desc" },
        skip: p.skip,
        take: p.limit,
      }),
      prisma.payrollRecord.count({ where }),
    ]);
    res.json(paginatedResponse(records, total, p));
  } catch (error) {
    log.error({ err: error }, "failed to fetch own payroll records");
    res.status(500).json({ error: "Failed to fetch payroll records" });
  }
});

// ---- Employee picker for manual records ----
router.get("/employees", authenticateUser, requirePayrollOrAdmin, async (_req, res) => {
  try {
    const employees = await prisma.employee.findMany({
      where: { isActive: true },
      select: { id: true, fullName: true, role: true, isActive: true },
      orderBy: { fullName: "asc" },
    });
    res.json({ data: employees, total: employees.length });
  } catch (error) {
    log.error({ err: error }, "failed to list payroll employees");
    res.status(500).json({ error: "Failed to list employees" });
  }
});

router.get("/records", authenticateUser, requirePayrollOrAdmin, async (req, res) => {
  try {
    const { employeeId, periodStart, periodEnd, status } = req.query;
    const where = {};
    if (employeeId) where.employeeId = String(employeeId);
    if (periodStart) where.periodStart = { gte: periodStart };
    if (periodEnd) where.periodEnd = { lte: periodEnd };
    if (status) where.status = status;
    const p = parsePagination(req.query);
    const [records, total] = await Promise.all([
      prisma.payrollRecord.findMany({
        where,
        include: { employee: { select: { id: true, fullName: true, role: true } } },
        orderBy: { periodStart: "desc" },
        skip: p.skip,
        take: p.limit,
      }),
      prisma.payrollRecord.count({ where }),
    ]);
    res.json(paginatedResponse(records, total, p));
  } catch (error) {
    log.error({ err: error }, "failed to fetch payroll records");
    res.status(500).json({ error: "Failed to fetch payroll records" });
  }
});

router.get("/records/:id", authenticateUser, requirePayrollOrAdmin, async (req, res) => {
  try {
    const record = await prisma.payrollRecord.findUnique({
      where: { id: req.params.id },
      include: { employee: { select: { id: true, fullName: true, role: true } } },
    });
    if (!record) return res.status(404).json({ error: "Payroll record not found" });
    res.json(record);
  } catch (error) {
    log.error({ err: error }, "failed to fetch payroll record");
    res.status(500).json({ error: "Failed to fetch payroll record" });
  }
});

router.patch(
  "/records/:id/status",
  authenticateUser,
  requirePayrollOrAdmin,
  validate(payrollRecordStatusSchema),
  async (req, res) => {
    try {
      const { id } = req.validated.params;
      const { status } = req.validated.body;
      const record = await prisma.payrollRecord.findUnique({ where: { id } });
      if (!record) return res.status(404).json({ error: "Payroll record not found" });

      if (record.status === status) {
        return res.status(400).json({ error: `Record is already ${status}` });
      }
      if (!isTransitionAllowed(record.status, status, req.user.role)) {
        return res.status(403).json({
          error: `Forbidden — cannot move record from ${record.status} to ${status} as ${req.user.role}`,
        });
      }

      const updated = await prisma.payrollRecord.update({
        where: { id },
        data: {
          status,
          ...(status === "approved"
            ? { approvedBy: req.user.username, approvedAt: new Date() }
            : {}),
          ...(status === "paid" ? { paidAt: new Date() } : {}),
          ...(status === "calculated" && record.status === "rejected"
            ? { approvedBy: null, approvedAt: null, paidAt: null }
            : {}),
        },
      });
      logAudit(
        "payroll_status",
        id,
        `Payroll ${record.status} -> ${status} by ${req.user.username}`,
      );
      res.json(updated);
    } catch (error) {
      log.error({ err: error }, "failed to update payroll record status");
      res.status(500).json({ error: "Failed to update payroll record" });
    }
  },
);

async function editRecord(req, res) {
  try {
    const { id } = req.validated.params;
    const body = req.validated.body;
    const existing = await prisma.payrollRecord.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Payroll record not found" });
    if (existing.status === "paid") {
      return res.status(400).json({ error: "Cannot change a paid record" });
    }

    const updateData = {};
    for (const key of ["basePay", "commissionPay", "totalBonuses", "totalDeductions"]) {
      if (body[key] !== undefined) updateData[key] = body[key];
    }
    if (body.notes !== undefined) updateData.notes = body.notes;
    if (Object.keys(updateData).some((k) => k !== "notes")) {
      updateData.netPay = netPayFrom(existing, updateData);
    }
    const record = await prisma.payrollRecord.update({ where: { id }, data: updateData });
    logAudit("payroll_amount", id, `Payroll amounts edited by ${req.user.username}`);
    res.json(record);
  } catch (error) {
    log.error({ err: error }, "failed to update payroll record amount");
    res.status(500).json({ error: "Failed to update payroll record" });
  }
}

router.patch(
  "/records/:id/amount",
  authenticateUser,
  requireAdmin,
  validate(payrollRecordAmountSchema),
  editRecord,
);
// General edit route: same fields plus notes, available to payroll staff too.
router.patch(
  "/records/:id",
  authenticateUser,
  requirePayrollOrAdmin,
  validate(payrollRecordAmountSchema),
  editRecord,
);

router.post(
  "/records",
  authenticateUser,
  requirePayrollOrAdmin,
  validate(createPayrollRecordSchema),
  async (req, res) => {
    try {
      const b = req.validated.body;
      const employee = await prisma.employee.findUnique({ where: { id: b.employeeId } });
      if (!employee) return res.status(404).json({ error: "Employee not found" });
      const basePay = b.basePay ?? 0;
      const commissionPay = b.commissionPay ?? 0;
      const totalBonuses = b.totalBonuses ?? 0;
      const totalDeductions = b.totalDeductions ?? 0;
      const record = await prisma.payrollRecord.create({
        data: {
          employeeId: b.employeeId,
          periodStart: b.periodStart,
          periodEnd: b.periodEnd,
          basePay,
          commissionPay,
          totalBonuses,
          totalDeductions,
          netPay: round2(basePay + commissionPay + totalBonuses - totalDeductions),
          notes: b.notes ?? "",
          status: "calculated",
          totalSessions: 0,
          totalHours: 0,
          totalBookings: 0,
          totalOrders: 0,
          totalRevenue: 0,
          breakdown: [],
          calculatedBy: req.user.username,
        },
      });
      logAudit("payroll_create", record.id, `Manual payroll record created by ${req.user.username}`);
      res.status(201).json(record);
    } catch (error) {
      log.error({ err: error }, "failed to create payroll record");
      res.status(500).json({ error: "Failed to create payroll record" });
    }
  },
);

router.delete("/records/:id", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const record = await prisma.payrollRecord.findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ error: "Payroll record not found" });
    if (record.status === "paid") {
      return res.status(400).json({ error: "Cannot delete a paid record" });
    }
    await prisma.payrollRecord.delete({ where: { id: req.params.id } });
    logAudit("payroll_delete", req.params.id, `Payroll record deleted by ${req.user.username}`);
    res.json({ ok: true });
  } catch (error) {
    log.error({ err: error }, "failed to delete payroll record");
    res.status(500).json({ error: "Failed to delete payroll record" });
  }
});

async function createRequest(req, res, type) {
  try {
    const { recordId } = req.validated.params;
    const { amount, reason, workSessionId } = req.validated.body;
    const payrollRecord = await prisma.payrollRecord.findUnique({
      where: { id: recordId },
      include: { employee: true },
    });
    if (!payrollRecord) return res.status(404).json({ error: "Payroll record not found" });
    if (payrollRecord.status === "paid") {
      return res.status(400).json({ error: "Cannot change a paid record" });
    }
    const created = await prisma.bonusDeductionRequest.create({
      data: {
        type,
        employeeId: payrollRecord.employeeId,
        payrollRecordId: recordId,
        amount,
        reason,
        workSessionId: workSessionId || null,
        requestedBy: req.user.username,
        status: "pending",
      },
    });
    logAudit("payroll_request", created.id, `${type} request for ${recordId} by ${req.user.username}`);
    res.status(201).json(created);
  } catch (error) {
    log.error({ err: error }, `failed to create ${type} request`);
    res.status(500).json({ error: `Failed to create ${type} request` });
  }
}

router.post(
  "/:recordId/bonus-request",
  authenticateUser,
  requirePayrollOrAdmin,
  validate(bonusDeductionRequestSchema),
  (req, res) => createRequest(req, res, "bonus"),
);

router.post(
  "/:recordId/deduction-request",
  authenticateUser,
  requirePayrollOrAdmin,
  validate(bonusDeductionRequestSchema),
  (req, res) => createRequest(req, res, "deduction"),
);

router.get("/:recordId/requests", authenticateUser, requirePayrollOrAdmin, async (req, res) => {
  try {
    const { recordId } = req.params;
    const where = { payrollRecordId: recordId };
    if (req.query.type === "bonus" || req.query.type === "deduction") {
      where.type = req.query.type;
    }
    const p = parsePagination(req.query);
    const [requests, total] = await Promise.all([
      prisma.bonusDeductionRequest.findMany({
        where,
        include: { employee: { select: { id: true, fullName: true } } },
        orderBy: { createdAt: "desc" },
        skip: p.skip,
        take: p.limit,
      }),
      prisma.bonusDeductionRequest.count({ where }),
    ]);
    res.json(paginatedResponse(requests, total, p));
  } catch (error) {
    log.error({ err: error }, "failed to fetch requests");
    res.status(500).json({ error: "Failed to fetch requests" });
  }
});

router.patch(
  "/requests/:requestId",
  authenticateUser,
  requireAdmin,
  validate(reviewRequestSchema),
  async (req, res) => {
    try {
      const { requestId } = req.validated.params;
      const { status, adminComment } = req.validated.body;
      const request = await prisma.bonusDeductionRequest.findUnique({
        where: { id: requestId },
      });
      if (!request) return res.status(404).json({ error: "Request not found" });

      const record = await prisma.payrollRecord.findUnique({
        where: { id: request.payrollRecordId },
      });
      if (record?.status === "paid") {
        return res.status(400).json({ error: "Cannot change a paid record" });
      }

      const updatedRequest = await prisma.bonusDeductionRequest.update({
        where: { id: requestId },
        data: {
          status,
          reviewedBy: req.user.username,
          reviewedAt: new Date(),
          adminComment: adminComment || null,
        },
      });

      const totals = await recomputeApprovedTotals(
        request.payrollRecordId,
        record?.basePay ?? 0,
        record?.commissionPay ?? 0,
      );
      await prisma.payrollRecord.update({
        where: { id: request.payrollRecordId },
        data: totals,
      });
      logAudit(
        "payroll_request_review",
        requestId,
        `${request.type} request ${status} by ${req.user.username}`,
      );
      res.json(updatedRequest);
    } catch (error) {
      log.error({ err: error }, "failed to update request");
      res.status(500).json({ error: "Failed to update request" });
    }
  },
);

router.post(
  "/notify",
  authenticateUser,
  requirePayrollOrAdmin,
  validate(payrollNotifySchema),
  async (req, res) => {
    try {
      const { periodStart, periodEnd } = req.validated.body;
      await createBroadcastNotification(prisma, {
        type: "payroll",
        title: "Payroll is ready",
        body: `Payroll for ${periodStart} – ${periodEnd} is ready for review.`,
        data: { periodStart, periodEnd },
      });
      logAudit("payroll_notify", "payroll", `Staff notified about ${periodStart}..${periodEnd} by ${req.user.username}`);
      res.json({ ok: true });
    } catch (error) {
      log.error({ err: error }, "failed to notify staff about payroll");
      res.status(500).json({ error: "Failed to notify staff" });
    }
  },
);

export default router;
