import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// Simulate the three caller types without depending on real token formats.
vi.mock("../../src/middleware/auth.js", () => ({
  authenticateUser: (req, res, next) => {
    if (!req.headers["x-test-staff"]) return res.status(401).json({ error: "Unauthorized" });
    req.user = { id: 1, role: "admin", username: "admin" };
    next();
  },
  requireStaff: (_req, _res, next) => next(),
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
    // Emulate the real middleware, which clears IncomingMessage's built-in
    // `client` (the socket) before resolving an optional client account.
    req.client = null;
    if (req.headers["x-test-staff"]) req.user = { id: 1, role: "admin", username: "admin" };
    else if (req.headers["x-test-client"]) req.client = { id: "cl-1" };
    next();
  },
}));

vi.mock("../../src/services/orders.js", () => ({
  validateProofImage: () => ({ valid: true }),
  createOrderTransactional: vi.fn(async (_tx, body) => ({
    total: body.items.reduce((n, i) => n * 0 + i.price * i.qty, 0),
    discountAmount: 0,
    discountLabel: "",
    lines: body.items,
  })),
  restoreStockOnCancel: vi.fn(),
  computeRefundPlan: vi.fn(),
}));

vi.mock("../../src/services/evidence-store.js", () => ({
  storeEvidence: vi.fn(async () => "payment-evidence/ORD-TEST1/abc.png"),
  presignEvidence: vi.fn(async () => ({ url: "https://example.test/evidence", expiresAt: new Date() })),
  deleteEvidence: vi.fn(async () => true),
}));

vi.mock("../../src/lib/utils.js", () => ({
  nextId: vi.fn(async () => "ORD-TEST1"),
  todayStr: vi.fn(() => "2026-11-20"),
  logAudit: vi.fn(),
}));

vi.mock("../../src/lib/email.js", () => ({
  sendMail: vi.fn(async () => ({ ok: true })),
  buildOrderPlacedEmail: vi.fn(() => ({ subject: "order placed" })),
  buildPaymentSuccessEmail: vi.fn(() => ({ subject: "paid" })),
  buildPaymentFailedEmail: vi.fn(() => ({ subject: "failed" })),
  buildOrderStatusEmail: vi.fn(() => ({ subject: "status" })),
}));

import orderRoutes from "../../src/routes/orders.js";
import { logAudit } from "../../src/lib/utils.js";
import { storeEvidence } from "../../src/services/evidence-store.js";

// The per-route limiter reads this at request time so normal tests never trip it.
process.env.TRANSFER_SUBMISSION_RATE_MAX = "1000";

const app = express();
app.use(express.json());
app.use("/orders", orderRoutes);

function orderRecord(overrides = {}) {
  return {
    id: "ORD-TEST1",
    clientId: null,
    customerName: "Guest Customer",
    phone: "01000000000",
    email: "",
    status: "pending",
    paymentMethod: "instapay",
    paymentStatus: "unpaid",
    paymentRef: "",
    proofImage: "",
    paidAt: null,
    total: 100,
    ...overrides,
  };
}

const validOrderBody = {
  customerName: "Guest Customer",
  phone: "01000000000",
  items: [{ id: "p-1", name: "Food", price: 100, qty: 1 }],
  paymentMethod: "cash",
};

describe("Order creation starts unpaid (no customer-set paid state)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.order.create.mockImplementation(async ({ data }) => orderRecord(data));
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord());
    mockPrisma.order.update.mockImplementation(async ({ data }) => orderRecord(data));
    mockPrisma.payment.findMany.mockResolvedValue([{ id: "pay-1" }]);
    mockPrisma.payment.create.mockResolvedValue({ id: "pay-1" });
    mockPrisma.clinicSettings.findUnique.mockResolvedValue(null);
    mockPrisma.paymentVerification.create.mockImplementation(async ({ data }) => ({
      id: "pv-1", decision: data.decision, createdAt: new Date(), ...data,
    }));
    mockPrisma.paymentVerification.updateMany.mockResolvedValue({ count: 0 });
  });

  it("stores a cash order as unpaid/pending even if the client sends paymentRef/proofImage", async () => {
    const res = await request(app).post("/orders").send({
      ...validOrderBody,
      paymentRef: "PAID-NOW",
      proofImage: "data:image/png;base64,AAAA",
    });
    expect(res.status).toBe(400); // strict checkout schema rejects those fields
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
  });

  it("creates a store cash order unpaid, pending, with no Fawry reference", async () => {
    const res = await request(app).post("/orders").send(validOrderBody);
    expect(res.status).toBe(201);
    const data = mockPrisma.order.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      paymentStatus: "unpaid", status: "pending", paidAt: null,
      paymentRef: "", proofImage: "", source: "store",
    });
    expect(mockPrisma.payment.create.mock.calls[0][0].data).toMatchObject({ status: "unpaid", kind: "order" });
    expect(JSON.stringify(data)).not.toContain("PAW-");
  });

  it("creates an InstaPay order unpaid with no proof stored on the order", async () => {
    const res = await request(app).post("/orders").send({ ...validOrderBody, paymentMethod: "instapay" });
    expect(res.status).toBe(201);
    const data = mockPrisma.order.create.mock.calls[0][0].data;
    expect(data.paymentStatus).toBe("unpaid");
    expect(data.paymentRef).toBe("");
    expect(data.proofImage).toBe("");
    expect(mockPrisma.payment.create.mock.calls[0][0].data.status).toBe("unpaid");
  });

  it("rejects Fawry and store-supplied cash reception", async () => {
    expect((await request(app).post("/orders").send({ ...validOrderBody, paymentMethod: "fawry" })).status).toBe(400);
    expect((await request(app).post("/orders").send({ ...validOrderBody, cashReceived: true, cashReceivedAmount: 100 })).status).toBe(400);
  });

  it("lets authenticated POS staff settle cash at checkout with an approved verification", async () => {
    const res = await request(app)
      .post("/orders")
      .set("x-test-staff", "1")
      .send({ ...validOrderBody, source: "pos", cashReceived: true, cashReceivedAmount: 100 });
    expect(res.status).toBe(201);
    const data = mockPrisma.order.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ paymentStatus: "paid", status: "confirmed", source: "pos" });
    expect(data.paidAt).toBeInstanceOf(Date);
    expect(mockPrisma.paymentVerification.create.mock.calls[0][0].data).toMatchObject({
      source: "cash_reception", decision: "approved", reviewerId: 1, amount: 100,
    });
    expect(logAudit).toHaveBeenCalledWith("cash_received_pos", "ORD-TEST1", expect.any(String));
  });

  it("rejects a POS cash attestation on a non-cash order", async () => {
    const res = await request(app)
      .post("/orders")
      .set("x-test-staff", "1")
      .send({
        ...validOrderBody,
        paymentMethod: "instapay",
        source: "pos",
        cashReceived: true,
        cashReceivedAmount: 100,
      });
    expect(res.status).toBe(400);
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
  });

  it("rejects a POS cash attestation that does not match the total", async () => {
    const res = await request(app)
      .post("/orders")
      .set("x-test-staff", "1")
      .send({ ...validOrderBody, source: "pos", cashReceived: true, cashReceivedAmount: 90 });
    expect(res.status).toBe(400);
    expect(mockPrisma.order.create).not.toHaveBeenCalled();
  });

  it("keeps POS orders unpaid when cash is not attested", async () => {
    const res = await request(app).post("/orders").set("x-test-staff", "1").send({ ...validOrderBody, source: "pos" });
    expect(res.status).toBe(201);
    expect(mockPrisma.order.create.mock.calls[0][0].data.paymentStatus).toBe("unpaid");
    expect(mockPrisma.paymentVerification.create).not.toHaveBeenCalled();
  });

  it("links a signed-in client to their order", async () => {
    const res = await request(app).post("/orders").set("x-test-client", "1").send(validOrderBody);
    expect(res.status).toBe(201);
    expect(mockPrisma.order.create.mock.calls[0][0].data.clientId).toBe("cl-1");
  });
});

describe("Trusted verification endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ paymentMethod: "cash", status: "pending" }));
    mockPrisma.order.update.mockImplementation(async ({ data }) => orderRecord({ paymentMethod: "cash", ...data }));
    mockPrisma.payment.findMany.mockResolvedValue([{ id: "pay-1" }]);
    mockPrisma.payment.update.mockResolvedValue({});
    mockPrisma.paymentVerification.create.mockImplementation(async ({ data }) => ({
      id: "pv-1", decision: data.decision, createdAt: new Date(), ...data,
    }));
    mockPrisma.paymentVerification.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.clinicSettings.findUnique.mockResolvedValue(null);
  });

  it("blocks guests from confirming cash", async () => {
    const res = await request(app).post("/orders/ORD-TEST1/confirm-cash").send({ amountReceived: 100 });
    expect([401, 403]).toContain(res.status);
    expect(mockPrisma.paymentVerification.create).not.toHaveBeenCalled();
  });

  it("lets staff confirm the exact cash amount and marks the order paid", async () => {
    const res = await request(app)
      .post("/orders/ORD-TEST1/confirm-cash")
      .set("x-test-staff", "1")
      .send({ amountReceived: 100, note: "counted" });
    expect(res.status).toBe(200);
    expect(res.body.paymentStatus).toBe("paid");
    expect(res.body.status).toBe("confirmed");
    expect(mockPrisma.paymentVerification.create.mock.calls[0][0].data).toMatchObject({
      source: "cash_reception", decision: "approved", reviewerId: 1, amount: 100,
    });
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "paid" }) })
    );
    expect(logAudit).toHaveBeenCalledWith("cash_received", "ORD-TEST1", expect.any(String));
  });

  it("rejects a mismatched cash amount with 400", async () => {
    const res = await request(app)
      .post("/orders/ORD-TEST1/confirm-cash")
      .set("x-test-staff", "1")
      .send({ amountReceived: 99 });
    expect(res.status).toBe(400);
    expect(mockPrisma.paymentVerification.create).not.toHaveBeenCalled();
  });

  it("returns 409 when the order is already paid", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ paymentMethod: "cash", paymentStatus: "paid" }));
    const res = await request(app)
      .post("/orders/ORD-TEST1/confirm-cash")
      .set("x-test-staff", "1")
      .send({ amountReceived: 100 });
    expect(res.status).toBe(409);
  });

  it("requires an InstaPay order for transfer submission", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ paymentMethod: "cash" }));
    const res = await request(app)
      .post("/orders/ORD-TEST1/transfer-submission")
      .send({ senderName: "Guest Customer", transferReference: "TXN-123", phone: "01000000000" });
    expect(res.status).toBe(400);
    expect(storeEvidence).not.toHaveBeenCalled();
  });

  it("accepts a guest transfer submission with matching phone and hides the evidence key", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ paymentMethod: "instapay" }));
    const res = await request(app)
      .post("/orders/ORD-TEST1/transfer-submission")
      .send({
        senderName: "Guest Customer", transferReference: "TXN-123", phone: "01000000000",
        evidenceBase64: "data:image/png;base64,AAAA",
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "pv-1", decision: "submitted", createdAt: expect.any(String) });
    expect(res.body.evidenceKey).toBeUndefined();
    expect(storeEvidence).toHaveBeenCalled();
    expect(mockPrisma.paymentVerification.create.mock.calls[0][0].data).toMatchObject({
      source: "customer_transfer", decision: "submitted", customerRef: "TXN-123",
      evidenceKey: "payment-evidence/ORD-TEST1/abc.png", amount: 100,
    });
    expect(logAudit).toHaveBeenCalledWith("transfer_submitted", "ORD-TEST1", expect.any(String));
  });

  it("enforces ownership for signed-in clients and guests", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ clientId: "cl-other" }));
    expect((await request(app)
      .post("/orders/ORD-TEST1/transfer-submission")
      .set("x-test-client", "1")
      .send({ senderName: "Other Client", transferReference: "TXN-123" })).status).toBe(403);

    mockPrisma.order.findUnique.mockResolvedValue(orderRecord());
    expect((await request(app)
      .post("/orders/ORD-TEST1/transfer-submission")
      .send({ senderName: "Guest Customer", transferReference: "TXN-123", phone: "09999999999" })).status).toBe(403);
  });

  it("forwards the legacy payment-proof route into transfer submission without storing base64 on the order", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ paymentMethod: "instapay" }));
    const res = await request(app)
      .post("/orders/ORD-TEST1/payment-proof")
      .send({ paymentRef: "TXN-LEGACY", phone: "01000000000" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("pv-1");
    expect(mockPrisma.order.update.mock.calls[0][0].data).not.toHaveProperty("proofImage", expect.stringContaining("base64"));
  });

  it("rejects a legacy proof image without a real transfer reference", async () => {
    const res = await request(app)
      .post("/orders/ORD-TEST1/payment-proof")
      .send({ proofImage: "data:image/png;base64,AAAA", phone: "01000000000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("A real transfer reference is required.");
    expect(mockPrisma.paymentVerification.create).not.toHaveBeenCalled();
  });

  it("rejects the legacy proof route for cash orders", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ paymentMethod: "cash" }));
    const res = await request(app).post("/orders/ORD-TEST1/payment-proof").send({ paymentRef: "TXN-1" });
    expect(res.status).toBe(400);
  });
});

describe("Old payment holes are closed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.payment.findMany.mockResolvedValue([{ id: "pay-1" }]);
  });

  it("PATCH /orders/:id/payment refuses to set paid with the required message", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ paymentStatus: "proof_submitted" }));
    const res = await request(app)
      .patch("/orders/ORD-TEST1/payment")
      .set("x-test-staff", "1")
      .send({ paymentStatus: "paid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Use cash confirmation or transfer verification to mark an order paid.");
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it("PATCH /orders/:id/payment refuses Fawry", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord());
    const res = await request(app)
      .patch("/orders/ORD-TEST1/payment")
      .set("x-test-staff", "1")
      .send({ paymentStatus: "unpaid", paymentMethod: "fawry" });
    expect(res.status).toBe(400);
  });

  it("PATCH /orders/:id/status blocks completion until payment is verified", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ paymentStatus: "unpaid" }));
    const blocked = await request(app)
      .patch("/orders/ORD-TEST1/status")
      .set("x-test-staff", "1")
      .send({ status: "completed" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toBe("Payment must be verified before completing an order.");

    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ paymentStatus: "paid" }));
    mockPrisma.order.update.mockResolvedValue(orderRecord({ status: "completed", paymentStatus: "paid" }));
    const allowed = await request(app)
      .patch("/orders/ORD-TEST1/status")
      .set("x-test-staff", "1")
      .send({ status: "completed" });
    expect(allowed.status).toBe(200);
  });

  it("cancellation remains allowed for unpaid orders", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ paymentStatus: "unpaid" }));
    mockPrisma.order.update.mockResolvedValue(orderRecord({ status: "cancelled" }));
    const res = await request(app)
      .patch("/orders/ORD-TEST1/status")
      .set("x-test-staff", "1")
      .send({ status: "cancelled" });
    expect(res.status).toBe(200);
  });
});
