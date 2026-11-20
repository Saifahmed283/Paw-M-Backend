import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

vi.mock("../../src/middleware/auth.js", () => ({
  authenticateUser: (req, _res, next) => {
    req.user = { id: 1, username: "admin", role: "admin" };
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));

import authRoutes from "../../src/routes/auth.js";
import { resolveEmployeeId } from "../../src/lib/resolve-employee.js";

const app = express();
app.use(express.json());
app.use("/auth", authRoutes);

const NEW_ACCOUNT = { username: "newuser", password: "secret123", role: "staff" };
const ACCOUNT = {
  id: 7,
  username: "newuser",
  role: "staff",
  isActive: true,
  createdAt: new Date(),
  employeeId: null,
};

function accountFromData(data) {
  return { ...ACCOUNT, ...data };
}

describe("account/employee pairing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.auditLog.create.mockResolvedValue({});
    mockPrisma.adminUser.create.mockImplementation(async ({ data }) => accountFromData(data));
    mockPrisma.adminUser.update.mockImplementation(async ({ data }) => accountFromData(data));
  });

  it("creates the companion employee and stores the explicit link in one transaction", async () => {
    mockPrisma.adminUser.findUnique.mockResolvedValue(null);
    mockPrisma.employee.findFirst.mockResolvedValue(null);
    mockPrisma.employee.create.mockResolvedValue({ id: "emp-9" });

    const res = await request(app).post("/auth/accounts").send(NEW_ACCOUNT);

    expect(res.status).toBe(201);
    expect(res.body.employeeId).toBe("emp-9");
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.employee.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.adminUser.create.mock.calls[0][0].data.employeeId).toBe("emp-9");
    const created = mockPrisma.employee.create.mock.calls[0][0].data;
    expect(created.email).toBe("newuser@paw-m.local");
    expect(created.role).toBe("staff");
  });

  it("reuses an existing employee by the legacy username/email rule and stores the link", async () => {
    mockPrisma.adminUser.findUnique.mockResolvedValue(null);
    mockPrisma.employee.findFirst.mockResolvedValue({
      id: "emp-existing",
      email: "newuser@clinic.example.com",
    });

    const res = await request(app).post("/auth/accounts").send(NEW_ACCOUNT);

    expect(res.status).toBe(201);
    expect(mockPrisma.employee.create).not.toHaveBeenCalled();
    expect(mockPrisma.adminUser.create.mock.calls[0][0].data.employeeId).toBe("emp-existing");
    expect(res.body.employeeId).toBe("emp-existing");
    expect(mockPrisma.employee.findFirst.mock.calls[0][0].where).toEqual({
      OR: [{ email: "newuser" }, { email: { startsWith: "newuser@" } }],
    });
  });

  it("rolls back the whole transaction when companion employee provisioning fails", async () => {
    mockPrisma.adminUser.findUnique.mockResolvedValue(null);
    mockPrisma.employee.findFirst.mockResolvedValue(null);
    mockPrisma.employee.create.mockRejectedValue(new Error("employee table down"));

    const res = await request(app).post("/auth/accounts").send(NEW_ACCOUNT);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to create employee profile for account");
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // No account is committed (and no manual delete workaround is needed).
    expect(mockPrisma.adminUser.create).not.toHaveBeenCalled();
    expect(mockPrisma.adminUser.delete).not.toHaveBeenCalled();
  });

  it("syncs the linked employee role in the same transaction as the account role", async () => {
    mockPrisma.adminUser.findUnique.mockResolvedValue({ ...ACCOUNT, employeeId: "emp-9" });
    mockPrisma.employee.update.mockResolvedValue({});

    const res = await request(app).patch("/auth/accounts/7/role").send({ role: "payroll" });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe("payroll");
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.employee.update).toHaveBeenCalledWith({
      where: { id: "emp-9" },
      data: { role: "payroll" },
    });
  });

  it("does not rewrite the employee email when the username changes", async () => {
    mockPrisma.adminUser.findUnique.mockImplementation(async ({ where }) =>
      where.username === "renamed" ? null : { ...ACCOUNT, employeeId: "emp-9" },
    );

    const res = await request(app).patch("/auth/accounts/7").send({ username: "renamed" });

    expect(res.status).toBe(200);
    expect(mockPrisma.adminUser.update.mock.calls[0][0].data).toMatchObject({
      username: "renamed",
    });
    expect(mockPrisma.employee.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.employee.update).not.toHaveBeenCalled();
  });

  it("keeps the username uniqueness check and the last-active-admin guard", async () => {
    mockPrisma.adminUser.findUnique.mockImplementation(async ({ where }) =>
      where.username === "taken" ? { id: 99, username: "taken" } : { ...ACCOUNT, employeeId: "emp-9" },
    );
    const conflict = await request(app).patch("/auth/accounts/7").send({ username: "taken" });
    expect(conflict.status).toBe(409);
    expect(mockPrisma.adminUser.update).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockPrisma.adminUser.findUnique.mockResolvedValue({
      ...ACCOUNT,
      role: "admin",
      isActive: true,
      employeeId: "emp-admin",
    });
    mockPrisma.adminUser.count.mockResolvedValue(0);
    const guarded = await request(app).patch("/auth/accounts/7/role").send({ role: "staff" });
    expect(guarded.status).toBe(400);
    expect(mockPrisma.adminUser.update).not.toHaveBeenCalled();
    expect(mockPrisma.employee.update).not.toHaveBeenCalled();
  });

  it("resolveEmployeeId prefers the explicit link", async () => {
    mockPrisma.adminUser.findUnique.mockResolvedValue({
      username: "old-name",
      employeeId: "emp-explicit",
    });

    expect(await resolveEmployeeId(7)).toBe("emp-explicit");
    expect(mockPrisma.employee.findFirst).not.toHaveBeenCalled();
  });

  it("resolveEmployeeId keeps the legacy fallback for unlinked accounts", async () => {
    mockPrisma.adminUser.findUnique.mockResolvedValue({ username: "legacy", employeeId: null });
    mockPrisma.employee.findFirst.mockResolvedValue({ id: "emp-legacy" });

    expect(await resolveEmployeeId(7)).toBe("emp-legacy");
    expect(mockPrisma.employee.findFirst).toHaveBeenCalledTimes(1);
  });
});
