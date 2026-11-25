import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../src/lib/resolve-employee.js", () => ({ resolveEmployeeId: vi.fn(async () => "EMP-1") }));
vi.mock("../../src/lib/utils.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logAudit: vi.fn() };
});
vi.mock("../../src/middleware/auth.js", () => ({
  authenticateUser: (req, res, next) => {
    if (!req.headers["x-test-staff"]) return res.status(401).json({ error: "Unauthorized" });
    req.user = {
      id: 7,
      role: req.headers["x-test-role"] || "admin",
      username: "cashier",
    };
    next();
  },
  requireStaff: (req, res, next) => (req.user ? next() : res.status(401).json({ error: "Unauthorized" })),
  requireAdmin: (req, res, next) =>
    req.user?.role === "admin" ? next() : res.status(403).json({ error: "Forbidden" }),
}));

import cashWithdrawalRoutes from "../../src/routes/cash-withdrawals.js";
import workDayRoutes from "../../src/routes/work-days.js";

const app = express();
app.use(express.json());
app.use("/cash-withdrawals", cashWithdrawalRoutes);
app.use("/work-days", workDayRoutes);

const staffHeaders = { "x-test-staff": "1", "x-test-role": "staff" };
const adminHeaders = { "x-test-staff": "1", "x-test-role": "admin" };
const DAY = "2026-11-25";

function withdrawal(overrides = {}) {
  return {
    id: "CW-1",
    date: DAY,
    amount: 50,
    note: "Transport to supplier",
    status: "pending",
    requestedBy: 7,
    employeeId: "EMP-1",
    workSessionId: "WS-1",
    reviewNote: "",
    reviewedBy: null,
    reviewerUsername: null,
    reviewedAt: null,
    createdAt: new Date(`${DAY}T10:00:00.000Z`),
    requester: { id: 7, username: "cashier" },
    reviewer: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.adminUser.findMany.mockResolvedValue([
    { id: 7, username: "cashier", employeeId: "EMP-1" },
  ]);
  mockPrisma.employee.findMany.mockResolvedValue([
    { id: "EMP-1", fullName: "Cashier One", role: "staff", email: "cashier@example.com" },
  ]);
  mockPrisma.workSession.findFirst.mockResolvedValue({ id: "WS-1" });
  mockPrisma.cashDrawerClose.findFirst.mockResolvedValue(null);
  mockPrisma.cashCustody.findMany.mockResolvedValue([{ openingAmount: 100 }]);
  mockPrisma.paymentVerification.aggregate.mockResolvedValue({ _sum: { amount: 1000 } });
  mockPrisma.cashWithdrawal.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  mockPrisma.cashWithdrawal.findMany.mockResolvedValue([withdrawal()]);
  mockPrisma.cashWithdrawal.findUnique.mockResolvedValue(withdrawal());
  mockPrisma.cashWithdrawal.create.mockImplementation(async ({ data }) =>
    withdrawal({ ...data, requester: { id: 7, username: "cashier" } }),
  );
  mockPrisma.cashWithdrawal.update.mockImplementation(async ({ data }) =>
    withdrawal({ ...data, requester: { id: 7, username: "cashier" } }),
  );
});

describe("cash withdrawal API", () => {
  it("lets staff submit a reasoned withdrawal against available cash", async () => {
    const response = await request(app)
      .post("/cash-withdrawals")
      .set(staffHeaders)
      .send({ date: DAY, amount: 50, note: "Transport to supplier" });

    expect(response.status).toBe(201);
    expect(response.body.withdrawal).toMatchObject({
      amount: 50,
      note: "Transport to supplier",
      status: "pending",
      employeeName: "Cashier One",
    });
    expect(response.body.available).toBe(1050);
  });

  it("requires a reason note", async () => {
    const response = await request(app)
      .post("/cash-withdrawals")
      .set(staffHeaders)
      .send({ date: DAY, amount: 50, note: "  " });

    expect(response.status).toBe(400);
  });

  it("blocks a withdrawal that exceeds available cash", async () => {
    mockPrisma.cashWithdrawal.aggregate.mockResolvedValue({ _sum: { amount: 1060 } });
    const response = await request(app)
      .post("/cash-withdrawals")
      .set(staffHeaders)
      .send({ date: DAY, amount: 50, note: "Transport to supplier" });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/insufficient cash/i);
    expect(response.body.available).toBe(40);
  });

  it("re-checks drawer cash at approval time", async () => {
    mockPrisma.cashDrawerClose.findFirst.mockResolvedValue({
      id: "CD-1",
      date: DAY,
      expected: 1000,
      counted: 40,
      variance: -960,
      note: "",
      countedBy: 7,
    });
    const response = await request(app)
      .post("/cash-withdrawals/CW-1/approve")
      .set(adminHeaders)
      .send({ note: "Verified" });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/insufficient cash/i);
    expect(mockPrisma.cashWithdrawal.update).not.toHaveBeenCalled();
  });

  it("approves when the remaining counted cash is enough", async () => {
    mockPrisma.cashDrawerClose.findFirst.mockResolvedValue({
      id: "CD-1",
      date: DAY,
      expected: 1000,
      counted: 100,
      variance: -900,
      note: "",
      countedBy: 7,
    });
    const response = await request(app)
      .post("/cash-withdrawals/CW-1/approve")
      .set(adminHeaders)
      .send({ note: "Verified" });

    expect(response.status).toBe(200);
    expect(response.body.withdrawal.status).toBe("approved");
    expect(response.body.withdrawal.reviewNote).toBe("Verified");
    expect(response.body.available).toBe(50);
  });

  it("does not let a staff account approve requests", async () => {
    const response = await request(app)
      .post("/cash-withdrawals/CW-1/approve")
      .set(staffHeaders)
      .send({});

    expect(response.status).toBe(403);
  });

  it("limits staff to their own requests when listing", async () => {
    const response = await request(app)
      .get(`/cash-withdrawals?date=${DAY}`)
      .set(staffHeaders);

    expect(response.status).toBe(200);
    expect(response.body.withdrawals).toHaveLength(1);
    expect(mockPrisma.cashWithdrawal.findMany.mock.calls[0][0].where).toMatchObject({
      date: DAY,
      requestedBy: 7,
    });
  });
});

describe("workday role scoping", () => {
  const DAY_24 = "2026-11-24";

  beforeEach(() => {
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.order.findMany.mockResolvedValue([
      { id: "ORD-1", createdAt: new Date(`${DAY_24}T10:05:00.000Z`), total: 100, status: "pending" },
    ]);
    mockPrisma.payment.findMany.mockResolvedValue([
      {
        id: "PAY-1",
        date: DAY_24,
        amount: 100,
        status: "paid",
        method: "cash",
        kind: "manual",
        requestedBy: "cashier",
        createdAt: new Date(`${DAY_24}T10:06:00.000Z`),
        items: [{ kind: "product", label: "Shampoo", amount: 100 }],
      },
    ]);
    mockPrisma.workSession.findMany.mockResolvedValue([
      {
        id: "WS-1",
        date: DAY_24,
        employeeId: "EMP-1",
        startedAt: new Date(`${DAY_24}T10:00:00.000Z`),
        endedAt: new Date(`${DAY_24}T10:01:00.000Z`),
        employee: { id: "EMP-1", fullName: "Cashier One", role: "staff", email: "cashier@example.com" },
        custody: { openingAmount: 100 },
      },
      {
        id: "WS-2",
        date: DAY_24,
        employeeId: "EMP-1",
        startedAt: new Date(`${DAY_24}T10:04:00.000Z`),
        endedAt: new Date(`${DAY_24}T10:30:00.000Z`),
        employee: { id: "EMP-1", fullName: "Cashier One", role: "staff", email: "cashier@example.com" },
        custody: { openingAmount: 0 },
      },
      {
        id: "WS-3",
        date: DAY_24,
        employeeId: "EMP-2",
        startedAt: new Date(`${DAY_24}T10:00:00.000Z`),
        endedAt: new Date(`${DAY_24}T10:45:00.000Z`),
        employee: { id: "EMP-2", fullName: "Other Staff", role: "staff", email: "other@example.com" },
        custody: { openingAmount: 0 },
      },
    ]);
    mockPrisma.auditLog.findMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `LOG-${index}`,
        action: "follow_up_system",
        target: "",
        detail: "Follow up system",
        createdAt: new Date(`${DAY_24}T10:10:0${index}.000Z`),
      })),
    );
    mockPrisma.paymentVerification.findMany.mockResolvedValue([]);
    mockPrisma.cashWithdrawal.findMany.mockResolvedValue([]);
    mockPrisma.employee.findMany.mockResolvedValue([
      { id: "EMP-1", fullName: "Cashier One", role: "staff", email: "cashier@example.com" },
      { id: "EMP-2", fullName: "Other Staff", role: "staff", email: "other@example.com" },
    ]);
  });

  it("collapses repeated staff activity into one card and one counted row", async () => {
    const response = await request(app).get(`/work-days/${DAY_24}`).set(adminHeaders);

    expect(response.status).toBe(200);
    expect(response.body.view).toBe("admin");
    expect(response.body.staff).toHaveLength(2);
    const cashier = response.body.staff.find((row) => row.id === "EMP-1");
    expect(cashier.shiftCount).toBe(2);
    expect(cashier.logs).toHaveLength(1);
    expect(cashier.logs[0].count).toBe(8);
    expect(cashier.cashCollected).toBe(100);
  });

  it("returns only the signed-in staff member's scoped data", async () => {
    const response = await request(app).get(`/work-days/${DAY_24}`).set(staffHeaders);

    expect(response.status).toBe(200);
    expect(response.body.view).toBe("staff");
    expect(response.body.scopeEmployeeId).toBe("EMP-1");
    expect(response.body.staff).toHaveLength(1);
    expect(response.body.staff[0].id).toBe("EMP-1");
    expect(response.body.bookings).toEqual([]);
    expect(response.body.orders).toHaveLength(1);
    expect(response.body.payments).toHaveLength(1);
    expect(response.body.finance.cashDrawer.counted).toBeNull();
    expect(response.body.finance.byMethod.find((row) => row.method === "cash").collected).toBe(100);
  });
});
