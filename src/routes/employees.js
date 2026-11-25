import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { isForeignKeyConstraintError } from "../lib/db-errors.js";
import { createEmployeeSchema, updateEmployeeSchema } from "../schemas/employees.js";

const router = Router();
const log = logger.child({ module: "routes/employees" });

const EMPLOYEE_SELECT = {
  id: true, fullName: true, email: true, phone: true, role: true,
  payRateType: true, hourlyRate: true, monthlySalary: true,
  roleHoursPerDay: true, commissionRates: true, isActive: true,
  avatarUrl: true, color: true,
  createdAt: true, updatedAt: true,
};

router.get("/", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const [employees, total] = await Promise.all([
      prisma.employee.findMany({ select: EMPLOYEE_SELECT, orderBy: { fullName: "asc" }, skip: p.skip, take: p.limit }),
      prisma.employee.count(),
    ]);
    res.json(paginatedResponse(employees, total, p));
  } catch (error) {
    log.error({ err: error }, "failed to fetch employees");
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

router.get("/:id", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const employee = await prisma.employee.findUnique({ where: { id: req.params.id }, select: EMPLOYEE_SELECT });
    if (!employee) return res.status(404).json({ error: "Employee not found" });
    res.json(employee);
  } catch (error) {
    log.error({ err: error }, "failed to fetch employee");
    res.status(500).json({ error: "Failed to fetch employee" });
  }
});

router.post("/", authenticateUser, requireAdmin, validate(createEmployeeSchema), async (req, res) => {
  try {
    const employee = await prisma.employee.create({ data: req.validated.body });
    res.status(201).json(employee);
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(400).json({ error: "Employee with this email already exists" });
    }
    log.error({ err: error }, "failed to create employee");
    res.status(500).json({ error: "Failed to create employee" });
  }
});

router.patch("/:id", authenticateUser, requireAdmin, validate(updateEmployeeSchema), async (req, res) => {
  const { id } = req.validated.params;
  const data = req.validated.body;
  try {
    const existing = await prisma.employee.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Employee not found" });
    if (data.email && data.email !== existing.email) {
      const emailExists = await prisma.employee.findFirst({ where: { email: data.email, NOT: { id } } });
      if (emailExists) return res.status(400).json({ error: "Email already in use" });
    }
    const employee = await prisma.employee.update({
      where: { id },
      data: { ...data, updatedAt: new Date() },
    });
    res.json(employee);
  } catch (error) {
    if (error.code === "P2002") return res.status(400).json({ error: "Email already in use" });
    log.error({ err: error }, "failed to update employee");
    res.status(500).json({ error: "Failed to update employee" });
  }
});

router.delete("/:id", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const existing = await prisma.employee.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Employee not found" });
    await prisma.employee.delete({ where: { id: req.params.id } });
    res.json({ ok: true, message: "Employee deleted successfully" });
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      return res
        .status(409)
        .json({ error: "Cannot delete employee with existing records. Suspend instead." });
    }
    log.error({ err: error }, "failed to delete employee");
    res.status(500).json({ error: "Failed to delete employee" });
  }
});

export default router;
