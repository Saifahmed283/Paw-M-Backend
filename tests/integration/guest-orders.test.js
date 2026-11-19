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
  authenticateUser: (req, _res, next) => {
    req.user = { id: 1, role: "admin" };
    next();
  },
  requireStaff: (_req, _res, next) => next(),
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
    if (req.headers["x-test-staff"]) req.user = { id: 1, role: "admin" };
    else if (req.headers["x-test-client"]) req.client = { id: "cl-1" };
    next();
  },
}));

vi.mock("../../src/services/orders.js", () => ({
  validateProofImage: () => ({ valid: true }),
  createOrderTransactional: vi.fn(async (_tx, body) => ({
    total: body.items.reduce((n, i) => n + i.price * i.qty, 0),
    discountAmount: 0,
    discountLabel: "",
    lines: body.items,
  })),
  restoreStockOnCancel: vi.fn(),
}));

vi.mock("../../src/lib/utils.js", () => ({
  nextId: vi.fn(async () => "ORD-TEST1"),
  fawryReference: vi.fn(() => "PAW-ABC123"),
  logAudit: vi.fn(),
}));

import orderRoutes from "../../src/routes/orders.js";

const app = express();
app.use(express.json());
app.use("/orders", orderRoutes);

function orderRecord(overrides = {}) {
  return {
    id: "ORD-TEST1",
    clientId: null,
    customerName: "Guest",
    phone: "01000000000",
    email: "",
    paymentMethod: "instapay",
    paymentStatus: "unpaid",
    paymentRef: "",
    proofImage: "",
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

describe("Guest checkout (orders)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.order.create.mockResolvedValue(orderRecord());
    mockPrisma.order.findUnique.mockResolvedValue(null);
    mockPrisma.order.update.mockImplementation(async ({ data }) => orderRecord(data));
    mockPrisma.clinicSettings.findUnique.mockResolvedValue(null);
    mockPrisma.notification.create.mockResolvedValue({});
  });

  it("creates an anonymous order with clientId null", async () => {
    const res = await request(app).post("/orders").send(validOrderBody);
    expect(res.status).toBe(201);
    expect(mockPrisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clientId: null }) }),
    );
  });

  it("confirms and marks a cash sale paid on creation", async () => {
    const res = await request(app).post("/orders").send(validOrderBody);
    expect(res.status).toBe(201);
    expect(mockPrisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "confirmed",
          paymentStatus: "paid",
        }),
      }),
    );
    const orderData = mockPrisma.order.create.mock.calls[0][0].data;
    expect(orderData.paidAt).toBeInstanceOf(Date);
    expect(mockPrisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "paid", kind: "order", orderId: "ORD-TEST1" }),
      }),
    );
  });

  it("puts InstaPay with proof under review and keeps the proof", async () => {
    const res = await request(app)
      .post("/orders")
      .send({
        ...validOrderBody,
        paymentMethod: "instapay",
        paymentRef: "TXN-77",
        proofImage: "data:image/png;base64,AAAA",
      });
    expect(res.status).toBe(201);
    const orderData = mockPrisma.order.create.mock.calls[0][0].data;
    expect(orderData.paymentStatus).toBe("proof_submitted");
    expect(orderData.status).toBe("pending");
    expect(orderData.paymentRef).toBe("TXN-77");
    expect(orderData.proofImage).toBe("data:image/png;base64,AAAA");
    expect(mockPrisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "proof_submitted", method: "instapay" }),
      }),
    );
  });

  it("keeps a customer-supplied Fawry voucher under review", async () => {
    const res = await request(app)
      .post("/orders")
      .send({ ...validOrderBody, paymentMethod: "fawry", paymentRef: "FAW-999" });
    expect(res.status).toBe(201);
    const orderData = mockPrisma.order.create.mock.calls[0][0].data;
    expect(orderData.paymentStatus).toBe("proof_submitted");
    expect(orderData.paymentRef).toBe("FAW-999");
    expect(orderData.proofImage).toBe("");
  });

  it("generates a Fawry reference only when the customer did not provide one", async () => {
    const res = await request(app)
      .post("/orders")
      .send({ ...validOrderBody, paymentMethod: "fawry" });
    expect(res.status).toBe(201);
    expect(mockPrisma.order.create.mock.calls[0][0].data.paymentRef).toBe("PAW-ABC123");
  });

  it("links an order to the signed-in client", async () => {
    const res = await request(app)
      .post("/orders")
      .set("x-test-client", "1")
      .send(validOrderBody);
    expect(res.status).toBe(201);
    expect(mockPrisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clientId: "cl-1" }) }),
    );
  });

  it("lets a guest submit proof when the phone matches", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord());
    const res = await request(app)
      .post("/orders/ORD-TEST1/payment-proof")
      .send({ paymentRef: "TXN-1", phone: "01000000000" });
    expect(res.status).toBe(200);
    expect(mockPrisma.order.update).toHaveBeenCalled();
  });

  it("syncs the linked Finance row when proof is submitted", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord());
    mockPrisma.payment.findMany.mockResolvedValue([{ id: "pay-1" }]);
    const res = await request(app)
      .post("/orders/ORD-TEST1/payment-proof")
      .send({ paymentRef: "TXN-1", phone: "01000000000" });
    expect(res.status).toBe(200);
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pay-1" }, data: { status: "proof_submitted" } }),
    );
  });

  it("syncs the linked Finance row and confirms the order when staff mark it paid", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(
      orderRecord({ paymentStatus: "proof_submitted", status: "pending", proofImage: "data:image/png;base64,AAAA" }),
    );
    mockPrisma.payment.findMany.mockResolvedValue([{ id: "pay-1" }]);
    const res = await request(app)
      .patch("/orders/ORD-TEST1/payment")
      .send({ paymentStatus: "paid" });
    expect(res.status).toBe(200);
    const orderUpdate = mockPrisma.order.update.mock.calls[0][0].data;
    expect(orderUpdate.paymentStatus).toBe("paid");
    expect(orderUpdate.status).toBe("confirmed");
    expect(orderUpdate.paidAt).toBeInstanceOf(Date);
    expect(mockPrisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pay-1" },
        data: expect.objectContaining({ status: "paid" }),
      }),
    );
  });

  it("refuses to mark an InstaPay order paid before proof is submitted", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ paymentStatus: "unpaid" }));
    const res = await request(app)
      .patch("/orders/ORD-TEST1/payment")
      .send({ paymentStatus: "paid" });
    expect(res.status).toBe(400);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it("rejects guest proof with a mismatched phone", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord());
    const res = await request(app)
      .post("/orders/ORD-TEST1/payment-proof")
      .send({ paymentRef: "TXN-1", phone: "09999999999" });
    expect(res.status).toBe(403);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it("rejects a client submitting proof for another client's order", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ clientId: "cl-other" }));
    const res = await request(app)
      .post("/orders/ORD-TEST1/payment-proof")
      .set("x-test-client", "1")
      .send({ paymentRef: "TXN-1" });
    expect(res.status).toBe(403);
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it("allows staff to submit proof for any order", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(orderRecord({ clientId: "cl-other" }));
    const res = await request(app)
      .post("/orders/ORD-TEST1/payment-proof")
      .set("x-test-staff", "1")
      .send({ paymentRef: "TXN-1" });
    expect(res.status).toBe(200);
    expect(mockPrisma.order.update).toHaveBeenCalled();
  });
});

describe("optional client auth with a real Express request", () => {
  it("clears IncomingMessage's socket-backed `client` for guests", async () => {
    const { optionalClientAuth } = await vi.importActual("../../src/middleware/auth.js");
    const probe = express();
    probe.get("/probe", optionalClientAuth, (req, res) => {
      res.json({ isNull: req.client === null });
    });
    const res = await request(probe).get("/probe");
    expect(res.status).toBe(200);
    expect(res.body.isNull).toBe(true);
  });
});
