import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));
vi.mock("../../src/lib/utils.js", () => ({ logAudit: vi.fn() }));

vi.mock("../../src/middleware/auth.js", () => ({
  authenticateUser: (req, _res, next) => {
    req.user = { id: 1, username: "tester", role: req.headers["x-role"] ?? "admin" };
    next();
  },
  requireStaff: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) =>
    req.user.role === "admin" ? next() : res.status(403).json({ error: "forbidden" }),
  requirePayrollOrAdmin: (req, res, next) =>
    ["payroll", "admin"].includes(req.user.role)
      ? next()
      : res.status(403).json({ error: "forbidden" }),
}));

import payrollRoutes from "../../src/routes/payroll.js";
import { calculatePayrollSchema } from "../../src/schemas/payroll.js";

const app = express();
app.use(express.json());
app.use("/payroll", payrollRoutes);

function record(overrides = {}) {
  return {
    id: "PR-1",
    employeeId: "emp-1",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    basePay: 1000,
    commissionPay: 100,
    totalBonuses: 50,
    totalDeductions: 25,
    netPay: 1125,
    status: "calculated",
    notes: "",
    ...overrides,
  };
}

describe("payroll management", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validates and bounds the calculation period", () => {
    expect(
      calculatePayrollSchema.safeParse({
        body: { periodStart: "2026-02-01", periodEnd: "2026-01-31" },
      }).success,
    ).toBe(false);
    expect(
      calculatePayrollSchema.safeParse({
        body: { periodStart: "2026-01-01", periodEnd: "2026-01-31" },
      }).success,
    ).toBe(true);
  });

  it("creates a manual off-cycle record with a computed net pay", async () => {
    mockPrisma.employee.findUnique.mockResolvedValue({ id: "emp-1" });
    mockPrisma.payrollRecord.create.mockImplementation(async ({ data }) => ({ id: "PR-2", ...data }));

    const res = await request(app)
      .post("/payroll/records")
      .send({
        employeeId: "emp-1",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-01",
        basePay: 500,
        commissionPay: 40,
        totalBonuses: 10,
        totalDeductions: 60,
        notes: "Off-cycle",
      });

    expect(res.status).toBe(201);
    expect(res.body.netPay).toBe(490);
    expect(res.body.status).toBe("calculated");
    expect(res.body.notes).toBe("Off-cycle");
  });

  it("returns 404 when editing a record that does not exist", async () => {
    mockPrisma.payrollRecord.findUnique.mockResolvedValue(null);
    const res = await request(app).patch("/payroll/records/missing").send({ basePay: 1 });
    expect(res.status).toBe(404);
  });

  it("refuses to edit or delete a paid record", async () => {
    mockPrisma.payrollRecord.findUnique.mockResolvedValue(record({ status: "paid" }));

    const edit = await request(app).patch("/payroll/records/PR-1").send({ basePay: 2000 });
    expect(edit.status).toBe(400);

    const del = await request(app).delete("/payroll/records/PR-1");
    expect(del.status).toBe(400);
    expect(mockPrisma.payrollRecord.delete).not.toHaveBeenCalled();
  });

  it("allows a rejected record to be reopened as a draft", async () => {
    mockPrisma.payrollRecord.findUnique.mockResolvedValue(record({ status: "rejected" }));
    mockPrisma.payrollRecord.update.mockImplementation(async ({ data }) => ({
      ...record({ status: "rejected" }),
      ...data,
    }));

    const res = await request(app)
      .patch("/payroll/records/PR-1/status")
      .send({ status: "calculated" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("calculated");
    expect(res.body.approvedBy).toBeNull();
  });

  it("deletes a draft record", async () => {
    mockPrisma.payrollRecord.findUnique.mockResolvedValue(record());
    mockPrisma.payrollRecord.delete.mockResolvedValue({ ok: true });
    const res = await request(app).delete("/payroll/records/PR-1");
    expect(res.status).toBe(200);
    expect(mockPrisma.payrollRecord.delete).toHaveBeenCalledWith({ where: { id: "PR-1" } });
  });

  it("blocks payroll-role callers from admin-only delete", async () => {
    const res = await request(app)
      .delete("/payroll/records/PR-1")
      .set("x-role", "payroll");
    expect(res.status).toBe(403);
  });
});
