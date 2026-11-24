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
}));
vi.mock("../../src/lib/utils.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logAudit: vi.fn() };
});

import workSessionRoutes from "../../src/routes/work-sessions.js";
import { logAudit } from "../../src/lib/utils.js";

const app = express();
app.use(express.json());
app.use("/work-session", workSessionRoutes);

const staff = { "x-test-staff": "1" };
const session = {
  id: "ws-1",
  employeeId: "emp-1",
  date: "2026-11-24",
  startedAt: new Date("2026-11-24T09:00:00Z"),
  endedAt: null,
};
const custody = {
  id: "cc-1",
  workSessionId: "ws-1",
  employeeId: "emp-1",
  date: "2026-11-24",
  hasDrawer: true,
  openingAmount: 1250.5,
  note: "",
  createdAt: new Date("2026-11-24T09:05:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  // resolveEmployeeId looks up the AdminUser; return the explicit link.
  mockPrisma.adminUser.findUnique.mockResolvedValue({ username: "cashier", employeeId: "emp-1" });
  mockPrisma.workSession.findFirst.mockResolvedValue(session);
  mockPrisma.cashCustody.findUnique.mockResolvedValue(null);
  mockPrisma.cashCustody.create.mockResolvedValue(custody);
});

describe("Cash custody & handover", () => {
  it("rejects unauthenticated callers", async () => {
    expect((await request(app).get("/work-session/custody")).status).toBe(401);
    expect((await request(app).post("/work-session/custody").send({})).status).toBe(401);
  });

  it("returns null when no declaration exists", async () => {
    const res = await request(app).get("/work-session/custody").set(staff);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("returns the declaration when one exists", async () => {
    mockPrisma.cashCustody.findUnique.mockResolvedValue(custody);
    const res = await request(app).get("/work-session/custody").set(staff);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("cc-1");
    expect(res.body.openingAmount).toBe(1250.5);
  });

  it("saves a new custody declaration with a drawer", async () => {
    const res = await request(app)
      .post("/work-session/custody")
      .set(staff)
      .send({ hasDrawer: true, openingAmount: 1250.5, note: " float " });
    expect(res.status).toBe(201);
    expect(mockPrisma.cashCustody.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workSessionId: "ws-1",
        employeeId: "emp-1",
        hasDrawer: true,
        openingAmount: 1250.5,
        note: "float",
      }),
    });
    expect(logAudit).toHaveBeenCalledWith(
      "cash_custody_recorded",
      "ws-1",
      expect.stringContaining("opening=1250.5"),
    );
  });

  it("forces the amount to 0 when there is no drawer", async () => {
    mockPrisma.cashCustody.create.mockImplementation(async ({ data }) => ({ ...custody, ...data }));
    const res = await request(app)
      .post("/work-session/custody")
      .set(staff)
      .send({ hasDrawer: false, openingAmount: 999 });
    expect(res.status).toBe(201);
    expect(mockPrisma.cashCustody.create.mock.calls[0][0].data.openingAmount).toBe(0);
  });

  it("rejects a negative amount", async () => {
    const res = await request(app)
      .post("/work-session/custody")
      .set(staff)
      .send({ hasDrawer: true, openingAmount: -1 });
    expect(res.status).toBe(400);
    expect(mockPrisma.cashCustody.create).not.toHaveBeenCalled();
  });

  it("is idempotent for the same shift", async () => {
    mockPrisma.cashCustody.findUnique.mockResolvedValue(custody);
    const res = await request(app)
      .post("/work-session/custody")
      .set(staff)
      .send({ hasDrawer: false, openingAmount: 0 });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("cc-1");
    expect(mockPrisma.cashCustody.create).not.toHaveBeenCalled();
  });

  it("rejects when not checked in", async () => {
    mockPrisma.workSession.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .post("/work-session/custody")
      .set(staff)
      .send({ hasDrawer: false, openingAmount: 0 });
    expect(res.status).toBe(400);
    expect(mockPrisma.cashCustody.create).not.toHaveBeenCalled();
  });
});
