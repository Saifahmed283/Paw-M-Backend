import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireAdmin, requireStaff, requirePayrollOrAdmin } from "../middleware/auth.js";
import { calculatePayrollForPeriod, calculateSessionTotals, calculateBasePay } from "../services/payroll.js";

const router = Router();
const log = logger.child({ module: "routes/payroll-extended" });

router.get("/me", authenticateUser, requireStaff, async (req, res) => {
  try {
    const sessions = await prisma.workSession.findMany({
      where: { employeeId: req.user.id },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    res.json(sessions);
  } catch (error) {
    log.error({ err: error }, "failed to fetch work sessions");
    res.status(500).json({ error: "Failed to fetch work sessions" });
  }
});

router.get("/me/kpi", authenticateUser, requireStaff, async (req, res) => {
  try {
    const { periodStart, periodEnd } = req.query;
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: "Missing periodStart or periodEnd" });
    }
    const sessions = await prisma.workSession.findMany({
      where: { employeeId: req.user.id, date: { gte: periodStart, lte: periodEnd } },
    });
    const totals = calculateSessionTotals(sessions);
    const employee = await prisma.employee.findUnique({
      where: { id: req.user.id },
      select: { hourlyRate: true, monthlySalary: true, payRateType: true },
    });
    const daysInPeriod = (new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60 * 24) + 1;
    const basePay = employee ? calculateBasePay(employee, totals.hours, daysInPeriod) : 0;
    res.json({
      ...totals,
      basePay: parseFloat(basePay.toFixed(2)),
      grossPay: parseFloat((totals.commission + basePay).toFixed(2)),
    });
  } catch (error) {
    log.error({ err: error }, "failed to calculate KPI");
    res.status(500).json({ error: "Failed to calculate KPI" });
  }
});

router.get("/all", authenticateUser, requireAdmin, async (_req, res) => {
  try {
    const sessions = await prisma.workSession.findMany({
      include: { employee: { select: { id: true, fullName: true, role: true } } },
      orderBy: { startedAt: "desc" },
      take: 100,
    });
    res.json(sessions);
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
    const sessions = await prisma.workSession.findMany({
      where: { employeeId: userId, date: { gte: periodStart, lte: periodEnd } },
    });
    const totals = calculateSessionTotals(sessions);
    const employee = await prisma.employee.findUnique({
      where: { id: userId },
      select: { fullName: true, hourlyRate: true, monthlySalary: true, payRateType: true },
    });
    const daysInPeriod = (new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60 * 24) + 1;
    const basePay = employee ? calculateBasePay(employee, totals.hours, daysInPeriod) : 0;
    res.json({
      employeeId: userId,
      employeeName: employee?.fullName || "Unknown",
      ...totals,
      basePay: parseFloat(basePay.toFixed(2)),
      grossPay: parseFloat((totals.commission + basePay).toFixed(2)),
    });
  } catch (error) {
    log.error({ err: error }, "failed to calculate admin KPI");
    res.status(500).json({ error: "Failed to calculate KPI" });
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
    const savedRecords = await prisma.$transaction(
      enriched.map((record) => prisma.payrollRecord.create({ data: record }))
    );
    res.json({ records: savedRecords, count: savedRecords.length });
  } catch (error) {
    log.error({ err: error }, "failed to calculate payroll");
    res.status(500).json({ error: "Failed to calculate payroll" });
  }
});

export default router;
