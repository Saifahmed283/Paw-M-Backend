import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { resolveEmployeeId } from "../lib/resolve-employee.js";
import { authenticateUser, requireAdmin, requireStaff, requirePayrollOrAdmin } from "../middleware/auth.js";
import { calculatePayrollForPeriod } from "../services/payroll.js";
import { computeKpiOverview } from "../services/kpi.js";

const router = Router();
const log = logger.child({ module: "routes/payroll-extended" });

router.get("/me", authenticateUser, requireStaff, async (req, res) => {
  try {
    const employeeId = await resolveEmployeeId(req.user.id);
    if (!employeeId) return res.json(paginatedResponse([], 0, parsePagination(req.query)));
    const p = parsePagination(req.query);
    const [sessions, total] = await Promise.all([
      prisma.workSession.findMany({
        where: { employeeId },
        orderBy: { startedAt: "desc" },
        skip: p.skip,
        take: p.limit,
      }),
      prisma.workSession.count({ where: { employeeId } }),
    ]);
    res.json(paginatedResponse(sessions, total, p));
  } catch (error) {
    log.error({ err: error }, "failed to fetch work sessions");
    res.status(500).json({ error: "Failed to fetch work sessions" });
  }
});

router.get("/me/kpi", authenticateUser, requireStaff, async (req, res) => {
  try {
    const employeeId = await resolveEmployeeId(req.user.id);
    if (!employeeId) return res.status(400).json({ error: "No employee profile found." });
    const { periodStart, periodEnd } = req.query;
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: "Missing periodStart or periodEnd" });
    }
    const [kpi] = await computeKpiOverview({ periodStart, periodEnd, employeeIds: [employeeId] });
    res.json(kpi ?? null);
  } catch (error) {
    log.error({ err: error }, "failed to calculate KPI");
    res.status(500).json({ error: "Failed to calculate KPI" });
  }
});

router.get("/all", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const [sessions, total] = await Promise.all([
      prisma.workSession.findMany({
        include: { employee: { select: { id: true, fullName: true, role: true } } },
        orderBy: { startedAt: "desc" },
        skip: p.skip,
        take: p.limit,
      }),
      prisma.workSession.count(),
    ]);
    res.json(paginatedResponse(sessions, total, p));
  } catch (error) {
    log.error({ err: error }, "failed to fetch work sessions");
    res.status(500).json({ error: "Failed to fetch work sessions" });
  }
});

router.get("/admin/kpi", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const { userId, periodStart, periodEnd } = req.query;
    if (!userId || !periodStart || !periodEnd) {
      return res.status(400).json({ error: "Missing userId, periodStart, or periodEnd" });
    }
    const [kpi] = await computeKpiOverview({
      periodStart,
      periodEnd,
      employeeIds: [String(userId)],
    });
    if (!kpi) return res.status(404).json({ error: "Employee not found" });
    res.json(kpi);
  } catch (error) {
    log.error({ err: error }, "failed to calculate admin KPI");
    res.status(500).json({ error: "Failed to calculate KPI" });
  }
});

router.get("/admin/kpis", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const { periodStart, periodEnd } = req.query;
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: "Missing periodStart or periodEnd" });
    }
    const result = await computeKpiOverview({ periodStart, periodEnd });
    res.json({ data: result });
  } catch (error) {
    log.error({ err: error }, "failed to calculate admin KPIs");
    res.status(500).json({ error: "Failed to calculate KPIs" });
  }
});

router.patch("/:id/kpi", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const { bookingsCount, ordersCount, revenueTotal, commissionTotal } = req.body;
    const session = await prisma.workSession.update({
      where: { id: req.params.id },
      data: {
        bookingsCount: bookingsCount !== undefined ? bookingsCount : undefined,
        ordersCount: ordersCount !== undefined ? ordersCount : undefined,
        revenueTotal: revenueTotal !== undefined ? parseFloat(revenueTotal) : undefined,
        commissionTotal: commissionTotal !== undefined ? parseFloat(commissionTotal) : undefined,
      },
    });
    res.json(session);
  } catch (error) {
    log.error({ err: error }, "failed to update work session KPI");
    res.status(500).json({ error: "Failed to update work session" });
  }
});

router.post("/calculate", authenticateUser, requirePayrollOrAdmin, async (req, res) => {
  try {
    const { periodStart, periodEnd } = req.body;
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: "Missing periodStart or periodEnd" });
    }
    const records = await calculatePayrollForPeriod(periodStart, periodEnd);
    const enriched = records.map((r) => ({ ...r, calculatedBy: req.user.username }));

    // Upsert per employee + period so recalculating never creates duplicates.
    // Only "calculated" records are refreshed; anything already submitted,
    // approved, paid, or rejected keeps its locked amounts and is skipped.
    const existing = await prisma.payrollRecord.findMany({
      where: {
        periodStart,
        periodEnd,
        status: "calculated",
      },
      select: {
        id: true,
        employeeId: true,
        totalBonuses: true,
        totalDeductions: true,
      },
    });
    const existingByEmployee = new Map(existing.map((e) => [e.employeeId, e]));

    const saved = await prisma.$transaction(
      enriched.map((record) => {
        const match = existingByEmployee.get(record.employeeId);
        if (match) {
          // Preserve any approved bonuses/deductions already applied to the draft
          // and fold them back into the refreshed net pay.
          const netPay =
            record.basePay +
            record.commissionPay +
            match.totalBonuses -
            match.totalDeductions;
          return prisma.payrollRecord.update({
            where: { id: match.id },
            data: {
              totalSessions: record.totalSessions,
              totalHours: record.totalHours,
              totalBookings: record.totalBookings,
              totalOrders: record.totalOrders,
              totalRevenue: record.totalRevenue,
              basePay: record.basePay,
              commissionPay: record.commissionPay,
              netPay: parseFloat(netPay.toFixed(2)),
              breakdown: record.breakdown,
              calculatedBy: record.calculatedBy,
            },
          });
        }
        return prisma.payrollRecord.create({ data: record });
      }),
    );

    res.json({ records: saved, count: saved.length, recalculated: existing.length });
  } catch (error) {
    log.error({ err: error }, "failed to calculate payroll");
    res.status(500).json({ error: "Failed to calculate payroll" });
  }
});

export default router;
