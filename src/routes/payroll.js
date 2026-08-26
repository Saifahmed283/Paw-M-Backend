import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireAdmin, requirePayrollOrAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { calculatePayrollSchema, payrollRecordStatusSchema, payrollRecordAmountSchema, bonusDeductionRequestSchema, reviewRequestSchema } from "../schemas/payroll.js";

const router = Router();
const log = logger.child({ module: "routes/payroll" });

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
        orderBy: { createdAt: "desc" },
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

router.patch("/records/:id/status", authenticateUser, requireAdmin, validate(payrollRecordStatusSchema), async (req, res) => {
  try {
    const { id } = req.validated.params;
    const { status } = req.validated.body;
    const record = await prisma.payrollRecord.update({
      where: { id },
      data: {
        status,
        ...(status === "approved" ? { approvedBy: req.user.username, approvedAt: new Date() } : {}),
        ...(status === "paid" ? { paidAt: new Date() } : {}),
      },
    });
    res.json(record);
  } catch (error) {
    log.error({ err: error }, "failed to update payroll record status");
    res.status(500).json({ error: "Failed to update payroll record" });
  }
});

router.patch("/records/:id/amount", authenticateUser, requireAdmin, validate(payrollRecordAmountSchema), async (req, res) => {
  try {
    const { id } = req.validated.params;
    const body = req.validated.body;
    const updateData = {};
    if (body.basePay !== undefined) updateData.basePay = body.basePay;
    if (body.commissionPay !== undefined) updateData.commissionPay = body.commissionPay;
    if (body.totalBonuses !== undefined) updateData.totalBonuses = body.totalBonuses;
    if (body.totalDeductions !== undefined) updateData.totalDeductions = body.totalDeductions;
    if (Object.keys(updateData).length > 0) {
      const existing = await prisma.payrollRecord.findUnique({ where: { id } });
      if (existing) {
        const netPay = (updateData.basePay ?? existing.basePay) +
          (updateData.commissionPay ?? existing.commissionPay) +
          (updateData.totalBonuses ?? existing.totalBonuses) -
          (updateData.totalDeductions ?? existing.totalDeductions);
        updateData.netPay = parseFloat(netPay.toFixed(2));
      }
    }
    const record = await prisma.payrollRecord.update({ where: { id }, data: updateData });
    res.json(record);
  } catch (error) {
    log.error({ err: error }, "failed to update payroll record amount");
    res.status(500).json({ error: "Failed to update payroll record" });
  }
});

router.post("/:recordId/bonus-request", authenticateUser, requirePayrollOrAdmin, validate(bonusDeductionRequestSchema), async (req, res) => {
  try {
    const { recordId } = req.validated.params;
    const { amount, reason, workSessionId } = req.validated.body;
    const payrollRecord = await prisma.payrollRecord.findUnique({ where: { id: recordId }, include: { employee: true } });
    if (!payrollRecord) return res.status(404).json({ error: "Payroll record not found" });
    if (req.user.role === "payroll") {
      const payrollUser = await prisma.adminUser.findUnique({ where: { id: req.user.id } });
      const employee = payrollUser
        ? await prisma.employee.findFirst({
            where: { OR: [{ email: payrollUser.username }, { email: { startsWith: payrollUser.username + "@" } }] },
          })
        : null;
      if (!employee || payrollRecord.employeeId !== employee.id) {
        return res.status(403).json({ error: "Forbidden — can only request bonuses for your own employees" });
      }
    }
    const bonusRequest = await prisma.bonusDeductionRequest.create({
      data: {
        type: "bonus", employeeId: payrollRecord.employeeId, payrollRecordId: recordId,
        amount, reason, workSessionId: workSessionId || null,
        requestedBy: req.user.username, status: "pending",
      },
    });
    res.status(201).json(bonusRequest);
  } catch (error) {
    log.error({ err: error }, "failed to create bonus request");
    res.status(500).json({ error: "Failed to create bonus request" });
  }
});

router.post("/:recordId/deduction-request", authenticateUser, requirePayrollOrAdmin, validate(bonusDeductionRequestSchema), async (req, res) => {
  try {
    const { recordId } = req.validated.params;
    const { amount, reason, workSessionId } = req.validated.body;
    const payrollRecord = await prisma.payrollRecord.findUnique({ where: { id: recordId }, include: { employee: true } });
    if (!payrollRecord) return res.status(404).json({ error: "Payroll record not found" });
    if (req.user.role === "payroll") {
      const payrollUser = await prisma.adminUser.findUnique({ where: { id: req.user.id } });
      const employee = payrollUser
        ? await prisma.employee.findFirst({
            where: { OR: [{ email: payrollUser.username }, { email: { startsWith: payrollUser.username + "@" } }] },
          })
        : null;
      if (!employee || payrollRecord.employeeId !== employee.id) {
        return res.status(403).json({ error: "Forbidden — can only request deductions for your own employees" });
      }
    }
    const deductionRequest = await prisma.bonusDeductionRequest.create({
      data: {
        type: "deduction", employeeId: payrollRecord.employeeId, payrollRecordId: recordId,
        amount, reason, workSessionId: workSessionId || null,
        requestedBy: req.user.username, status: "pending",
      },
    });
    res.status(201).json(deductionRequest);
  } catch (error) {
    log.error({ err: error }, "failed to create deduction request");
    res.status(500).json({ error: "Failed to create deduction request" });
  }
});

router.get("/:recordId/requests", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const { recordId } = req.params;
    const { type } = req.query;
    const where = { payrollRecordId: recordId };
    if (type) where.type = type;
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

router.patch("/requests/:requestId", authenticateUser, requireAdmin, validate(reviewRequestSchema), async (req, res) => {
  try {
    const { requestId } = req.validated.params;
    const { status, adminComment } = req.validated.body;
    const request = await prisma.bonusDeductionRequest.findUnique({
      where: { id: requestId },
      include: { payrollRecord: true },
    });
    if (!request) return res.status(404).json({ error: "Request not found" });

    const updatedRequest = await prisma.bonusDeductionRequest.update({
      where: { id: requestId },
      data: { status, reviewedBy: req.user.username, reviewedAt: new Date(), adminComment: adminComment || null },
    });

    if (status === "approved") {
      const approvedRequests = await prisma.bonusDeductionRequest.findMany({
        where: { payrollRecordId: request.payrollRecordId, status: "approved" },
      });
      const totalBonuses = approvedRequests.filter((r) => r.type === "bonus").reduce((sum, r) => sum + r.amount, 0);
      const totalDeductions = approvedRequests.filter((r) => r.type === "deduction").reduce((sum, r) => sum + r.amount, 0);
      await prisma.payrollRecord.update({
        where: { id: request.payrollRecordId },
        data: {
          totalBonuses: parseFloat(totalBonuses.toFixed(2)),
          totalDeductions: parseFloat(totalDeductions.toFixed(2)),
          netPay: parseFloat(
            (request.payrollRecord.basePay + request.payrollRecord.commissionPay + totalBonuses - totalDeductions).toFixed(2)
          ),
        },
      });
    }
    res.json(updatedRequest);
  } catch (error) {
    log.error({ err: error }, "failed to update request");
    res.status(500).json({ error: "Failed to update request" });
  }
});

export default router;
