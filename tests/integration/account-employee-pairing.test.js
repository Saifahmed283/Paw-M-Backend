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

describe("account/employee pairing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.auditLog.create.mockResolvedValue({});
  });

  it("creates a companion employee with a resolvable username email", async () => {
    mockPrisma.adminUser.findUnique.mockResolvedValue(null);
    mockPrisma.adminUser.create.mockResolvedValue({
      id: 7,
      username: "newuser",
      role: "staff",
      isActive: true,
      createdAt: new Date(),
    });
    mockPrisma.employee.findFirst.mockResolvedValue(null);
    mockPrisma.employee.create.mockResolvedValue({ id: "emp-9" });

    const res = await request(app).post("/auth/accounts").send(NEW_ACCOUNT);

    expect(res.status).toBe(201);
    expect(mockPrisma.employee.create).toHaveBeenCalledTimes(1);
    const created = mockPrisma.employee.create.mock.calls[0][0].data;
    expect(created.email).toBe("newuser@paw-m.local");
    expect(created.role).toBe("staff");
    expect(created.isActive).toBe(true);

    // The exact pairing used by check-in must resolve back to that employee.
    mockPrisma.adminUser.findUnique.mockResolvedValue({ username: "newuser" });
    mockPrisma.employee.findFirst.mockResolvedValue({ id: "emp-9" });
    expect(await resolveEmployeeId(7)).toBe("emp-9");
  });

  it("reuses an existing employee matched by the username email prefix", async () => {
    mockPrisma.adminUser.findUnique.mockResolvedValue(null);
    mockPrisma.adminUser.create.mockResolvedValue({
      id: 8,
      username: "newuser",
      role: "staff",
      isActive: true,
      createdAt: new Date(),
    });
    mockPrisma.employee.findFirst.mockResolvedValue({
      id: "emp-existing",
      email: "newuser@clinic.example.com",
    });

    const res = await request(app).post("/auth/accounts").send(NEW_ACCOUNT);

    expect(res.status).toBe(201);
    expect(mockPrisma.employee.create).not.toHaveBeenCalled();
  });

  it("rolls back the account when companion employee provisioning fails", async () => {
    mockPrisma.adminUser.findUnique.mockResolvedValue(null);
    mockPrisma.adminUser.create.mockResolvedValue({
      id: 9,
      username: "newuser",
      role: "staff",
      isActive: true,
      createdAt: new Date(),
    });
    mockPrisma.employee.findFirst.mockResolvedValue(null);
    mockPrisma.employee.create.mockRejectedValue(new Error("employee table down"));

    const res = await request(app).post("/auth/accounts").send(NEW_ACCOUNT);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to create employee profile for account");
    expect(mockPrisma.adminUser.delete).toHaveBeenCalledWith({ where: { id: 9 } });
  });
});
