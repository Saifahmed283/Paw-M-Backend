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
