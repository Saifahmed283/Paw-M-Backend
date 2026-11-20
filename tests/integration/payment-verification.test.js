import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  authenticateUser: (req, res, next) => {
    if (!req.headers["x-test-staff"]) return res.status(401).json({ error: "Unauthorized" });
    req.user = { id: 7, role: req.headers["x-test-role"] || "admin", username: "cashier" };
    next();
  },
  requireStaff: (req, res, next) => (req.user ? next() : res.status(401).json({ error: "Unauthorized" })),
  requireAdmin: (req, res, next) =>
    req.user?.role === "admin" ? next() : res.status(403).json({ error: "Forbidden" }),
  authenticateClient: (req, _res, next) => {
    req.client = { id: "cl-1" };
    next();
  },
  authenticateClientOrStaff: (req, _res, next) => {
    req.client = { id: "cl-1" };
    next();
  },
  optionalClientOrStaff: (req, _res, next) => {
    req.client = null;
    if (req.headers["x-test-staff"]) req.user = { id: 7, role: "admin", username: "cashier" };
    else if (req.headers["x-test-client"]) req.client = { id: "cl-1" };
    next();
  },
}));

vi.mock("../../src/services/orders.js", () => ({
  validateProofImage: () => ({ valid: true }),
  createOrderTransactional: vi.fn(),
  restoreStockOnCancel: vi.fn(),
  computeRefundPlan: vi.fn(),
}));

vi.mock("../../src/services/evidence-store.js", () => ({
  storeEvidence: vi.fn(async () => "payment-evidence/ORD-1/abc.png"),
  presignEvidence: vi.fn(async () => ({ url: "https://objects.test/evidence?sig=1", expiresAt: new Date("2026-11-20T12:05:00Z") })),
  deleteEvidence: vi.fn(async () => true),
}));

vi.mock("../../src/lib/email.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
  buildOrderPlacedEmail: vi.fn(() => ({ subject: "placed" })),
  buildPaymentSuccessEmail: vi.fn(() => ({ subject: "success" })),
  buildPaymentFailedEmail: vi.fn(() => ({ subject: "failure" })),
  buildOrderStatusEmail: vi.fn(() => ({ subject: "status" })),
}));

vi.mock("../../src/lib/utils.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logAudit: vi.fn() };
});

import paymentVerificationRoutes from "../../src/routes/payment-verification.js";
import orderRoutes from "../../src/routes/orders.js";
import { logAudit, todayStr } from "../../src/lib/utils.js";
import { deleteEvidence, presignEvidence, storeEvidence } from "../../src/services/evidence-store.js";

process.env.TRANSFER_SUBMISSION_RATE_MAX = "1000";

const app = express();
app.use(express.json());
app.use("/orders", orderRoutes);
app.use("/payment-verification", paymentVerificationRoutes);

const staff = { "x-test-staff": "1" };
const clientToken = { Authorization: "Bearer opaque-client-token" };

function order(overrides = {}) {
  return {
    id: "ORD-1", clientId: "cl-1", customerName: "Luna's Owner", phone: "01000000000",
    email: "owner@example.test", status: "pending", paymentMethod: "instapay",
    paymentStatus: "unpaid", paidAt: null, total: 250, paymentRef: "", proofImage: "",
    items: [], ...overrides,
  };
}

function verification(overrides = {}) {
  return {
    id: "PV-1", orderId: "ORD-1", paymentId: "pay-1", method: "instapay", amount: 250,
    source: "customer_transfer", customerRef: "TXN-123", senderName: "Luna's Owner",
    transferredAt: null, evidenceKey: "payment-evidence/ORD-1/abc.png", note: "",
    decision: "submitted", bankTransactionReference: null, reviewerId: null,
    reviewedAt: null, createdAt: new Date(), ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.order.findUnique.mockResolvedValue(order());
  mockPrisma.order.update.mockImplementation(async ({ data }) => order(data));
  mockPrisma.payment.findMany.mockResolvedValue([{ id: "pay-1" }]);
  mockPrisma.payment.update.mockResolvedValue({});
  mockPrisma.paymentVerification.create.mockImplementation(async ({ data }) => verification(data));
  mockPrisma.paymentVerification.update.mockImplementation(async ({ data }) => verification({ ...data }));
  mockPrisma.paymentVerification.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.paymentVerification.findFirst.mockResolvedValue(null);
  mockPrisma.paymentVerification.count.mockResolvedValue(1);
  mockPrisma.paymentVerification.aggregate.mockResolvedValue({ _sum: { amount: 250 } });
  mockPrisma.paymentVerification.findMany.mockResolvedValue([]);
  mockPrisma.clinicSettings.findUnique.mockResolvedValue(null);
  mockPrisma.cashDrawerClose.create.mockImplementation(async ({ data }) => ({ id: "CD-1", ...data }));
  mockPrisma.cashDrawerClose.findFirst.mockResolvedValue(null);
});

describe("Admin access control", () => {
  it("returns 401 with no token and 403 for a client token", async () => {
    expect((await request(app).get("/payment-verification/admin/submissions")).status).toBe(401);
    const customer = await request(app).get("/payment-verification/admin/submissions").set(clientToken);
    expect(customer.status).toBe(403);
  });

  it("blocks customers from approve and reject", async () => {
    expect((await request(app).post("/payment-verification/admin/PV-1/approve").set(clientToken)
      .send({ bankTransactionReference: "BANK-1" })).status).toBe(403);
    expect((await request(app).post("/payment-verification/admin/PV-1/reject").set(clientToken)
      .send({ reason: "not a real transfer" })).status).toBe(403);
    expect(mockPrisma.paymentVerification.update).not.toHaveBeenCalled();
  });

  it("lists submissions with joined customer/reviewer fields", async () => {
    mockPrisma.paymentVerification.findMany.mockResolvedValue([verification({
      order: { customerName: "Luna's Owner", phone: "01000000000", total: 250 },
      reviewer: { username: "cashier" },
    })]);
    const res = await request(app).get("/payment-verification/admin/submissions?status=submitted").set(staff);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.submissions[0]).toMatchObject({
      id: "PV-1", orderId: "ORD-1", customerName: "Luna's Owner", phone: "01000000000",
      evidenceKey: "payment-evidence/ORD-1/abc.png", reviewerUsername: "cashier",
    });
    expect(JSON.stringify(res.body)).not.toContain("base64");
  });
});

describe("Admin verification decisions", () => {
  it("requires a bank transaction reference to approve", async () => {
    const res = await request(app).post("/payment-verification/admin/PV-1/approve").set(staff).send({});
    expect(res.status).toBe(400);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it("approves a transfer, settles the order once and records reviewer/audit fields", async () => {
    mockPrisma.paymentVerification.findUnique.mockResolvedValue(verification({ order: order() }));
    const res = await request(app)
      .post("/payment-verification/admin/PV-1/approve")
      .set(staff)
      .send({ bankTransactionReference: "BANK-123", note: "matched bank record" });
    expect(res.status).toBe(200);
    expect(res.body.order.paymentStatus).toBe("paid");
    const data = mockPrisma.paymentVerification.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      decision: "approved", bankTransactionReference: "BANK-123", reviewerId: 7,
      note: "matched bank record",
    });
    expect(data.reviewedAt).toBeInstanceOf(Date);
    expect(mockPrisma.order.update.mock.calls[0][0].data).toMatchObject({
      paymentStatus: "paid", status: "confirmed",
    });
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "paid" }) })
    );
    expect(logAudit).toHaveBeenCalledWith("transfer_approved", "ORD-1", expect.stringContaining("BANK-123"));
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
  });

  it("returns 409 for a duplicate bank reference without paying a second order", async () => {
    mockPrisma.paymentVerification.findUnique.mockResolvedValue(verification({ order: order() }));
    mockPrisma.paymentVerification.findFirst.mockResolvedValue({ id: "PV-OTHER" });
    const res = await request(app)
      .post("/payment-verification/admin/PV-1/approve")
      .set(staff)
      .send({ bankTransactionReference: "BANK-DUP" });
    expect(res.status).toBe(409);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it("maps a P2002 unique violation to 409", async () => {
    mockPrisma.paymentVerification.findUnique.mockResolvedValue(verification({ order: order() }));
    mockPrisma.paymentVerification.update.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await request(app)
      .post("/payment-verification/admin/PV-1/approve")
      .set(staff)
      .send({ bankTransactionReference: "BANK-RACE" });
    expect(res.status).toBe(409);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it("allows only one concurrent approval to settle the order", async () => {
    mockPrisma.paymentVerification.findUnique.mockResolvedValue(verification({ order: order() }));
    let calls = 0;
    mockPrisma.paymentVerification.update.mockImplementation(async () => {
      calls += 1;
      if (calls > 1) throw Object.assign(new Error("unique"), { code: "P2002" });
      return verification({ decision: "approved" });
    });
    const [a, b] = await Promise.all([
      request(app).post("/payment-verification/admin/PV-1/approve").set(staff).send({ bankTransactionReference: "BANK-RACE" }),
      request(app).post("/payment-verification/admin/PV-1/approve").set(staff).send({ bankTransactionReference: "BANK-RACE" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(mockPrisma.order.update).toHaveBeenCalledTimes(1);
  });

  it("rejects a transfer, returns the order to unpaid and permits resubmission", async () => {
    mockPrisma.paymentVerification.findUnique.mockResolvedValue(verification());
    mockPrisma.order.findUnique.mockResolvedValue(order({ paymentStatus: "unpaid" }));
    const rejected = await request(app)
      .post("/payment-verification/admin/PV-1/reject")
      .set(staff)
      .send({ reason: "transfer not found" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.decision).toBe("rejected");
    expect(rejected.body.reviewerId).toBe(7);
    expect(rejected.body.note).toBe("transfer not found");
    expect(mockPrisma.order.update.mock.calls[0][0].data).toMatchObject({ paymentStatus: "unpaid", paidAt: null });
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "unpaid" } })
    );
    expect(logAudit).toHaveBeenCalledWith("transfer_rejected", "ORD-1", expect.any(String));

    const resubmit = await request(app)
      .post("/orders/ORD-1/transfer-submission")
      .send({ senderName: "Luna's Owner", transferReference: "TXN-456", phone: "01000000000" });
    expect(resubmit.status).toBe(200);
    expect(mockPrisma.paymentVerification.create).toHaveBeenCalledTimes(1);
  });

  it("does not reject an already decided verification", async () => {
    mockPrisma.paymentVerification.findUnique.mockResolvedValue(verification({ decision: "approved" }));
    const res = await request(app)
      .post("/payment-verification/admin/PV-1/reject")
      .set(staff)
      .send({ reason: "too late now" });
    expect(res.status).toBe(409);
  });

  it("issues a five-minute evidence URL and hides the key from customers", async () => {
    const res = await request(app).get("/payment-verification/admin/PV-1/evidence-url").set(staff);
    expect(res.status).toBe(200);
    expect(presignEvidence).toHaveBeenCalledWith("payment-evidence/ORD-1/abc.png", 300);
    expect(res.body.url).toContain("objects.test");
    expect((await request(app).get("/payment-verification/admin/PV-1/evidence-url").set(clientToken)).status).toBe(403);
  });
});

describe("Cash drawer reconciliation", () => {
  const date = todayStr();

  it("uses the Cairo day bounds and computes expected/variance", async () => {
    const res = await request(app)
      .post("/payment-verification/admin/cash-drawer/close")
      .set(staff)
      .send({ countedAmount: 275.5, note: "end of day" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ date, expected: 250, counted: 275.5, variance: 25.5, countedBy: 7 });
    const aggregateCall = mockPrisma.paymentVerification.aggregate.mock.calls[0][0];
    expect(aggregateCall.where.decision).toBe("approved");
    expect(aggregateCall.where.source).toBe("cash_reception");
    expect(todayStr(aggregateCall.where.createdAt.gte)).toBe(date);
    expect(todayStr(new Date(aggregateCall.where.createdAt.lt.getTime() - 1))).toBe(date);
    expect(logAudit).toHaveBeenCalledWith("cash_drawer_closed", date, expect.any(String));
  });

  it("returns the latest close, recomputed expected total and verified payments", async () => {
    mockPrisma.cashDrawerClose.findFirst.mockResolvedValue({ id: "CD-1", date, expected: 250, counted: 250, variance: 0 });
    mockPrisma.paymentVerification.findMany.mockResolvedValue([verification({
      decision: "approved",
      source: "cash_reception",
      bankTransactionReference: null,
      order: { customerName: "Owner", phone: "010" },
    })]);
    const res = await request(app).get(`/payment-verification/admin/cash-drawer?date=${date}`).set(staff);
    expect(res.status).toBe(200);
    expect(res.body.close.id).toBe("CD-1");
    expect(res.body.expected).toBe(250);
    expect(res.body.payments[0]).toMatchObject({ source: "cash_reception", customerName: "Owner" });
    const listCall = mockPrisma.paymentVerification.findMany.mock.calls[0][0];
    expect(listCall.where.source).toBe("cash_reception");
  });

  it("rejects a malformed date and non-staff close attempts", async () => {
    expect((await request(app).get("/payment-verification/admin/cash-drawer?date=nope").set(staff)).status).toBe(400);
    expect((await request(app).post("/payment-verification/admin/cash-drawer/close").set(clientToken)
      .send({ countedAmount: 100 })).status).toBe(403);
  });
});

describe("Evidence cleanup on submission failure", () => {
  it("deletes a newly stored object if the database transaction fails", async () => {
    mockPrisma.paymentVerification.create.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app)
      .post("/orders/ORD-1/transfer-submission")
      .send({
        senderName: "Luna's Owner", transferReference: "TXN-789", phone: "01000000000",
        evidenceBase64: "data:image/png;base64,AAAA",
      });
    expect(res.status).toBe(500);
    expect(storeEvidence).toHaveBeenCalled();
    expect(deleteEvidence).toHaveBeenCalledWith("payment-evidence/ORD-1/abc.png");
  });
});
