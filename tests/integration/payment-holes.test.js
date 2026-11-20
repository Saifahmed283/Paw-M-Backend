import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));
vi.mock("../../src/middleware/auth.js", () => ({
  authenticateUser: (req, res, next) => {
    if (!req.headers["x-test-staff"]) return res.status(401).json({ error: "Unauthorized" });
    req.user = { id: 1, role: "admin", username: "admin" };
    next();
  },
  requireStaff: (_req, _res, next) => next(),
}));

import paymentRoutes from "../../src/routes/payments.js";

const staff = { "x-test-staff": "1" };
const app = express();
app.use(express.json());
app.use("/payments", paymentRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.payment.update.mockImplementation(async ({ data }) => ({ id: "pay-1", ...data }));
  mockPrisma.payment.create.mockImplementation(async ({ data }) => ({ id: "pay-1", ...data }));
  mockPrisma.order.findUnique.mockResolvedValue({ id: "ORD-1" });
  mockPrisma.payment.findMany.mockResolvedValue([]);
});

describe("Finance endpoints cannot settle order payments", () => {
  it("PATCH /payments/:id rejects paid for kind order", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({ id: "pay-1", kind: "order", orderId: "ORD-1" });
    const res = await request(app).patch("/payments/pay-1").set(staff).send({ status: "paid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Order payments are settled through verification only.");
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
  });

  it("PATCH /payments/:id allows paid for visit payments", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({ id: "pay-1", kind: "visit", orderId: "" });
    const res = await request(app).patch("/payments/pay-1").set(staff).send({ status: "paid" });
    expect(res.status).toBe(200);
  });

  it("POST /payments/:id/settle rejects order payments", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({ id: "pay-1", kind: "order", orderId: "ORD-1", status: "unpaid", items: [] });
    const res = await request(app).post("/payments/pay-1/settle").set(staff).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Order payments are settled through verification only.");
  });

  it("POST /payments rejects creating a paid order payment", async () => {
    const res = await request(app).post("/payments").set(staff).send({
      title: "Order ORD-1", amount: 100, kind: "order", orderId: "ORD-1", status: "paid",
    });
    expect(res.status).toBe(400);
    expect(mockPrisma.payment.create).not.toHaveBeenCalled();
  });
});
