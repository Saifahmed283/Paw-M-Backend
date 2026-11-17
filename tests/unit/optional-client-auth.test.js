import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    clientSession: { findFirst: vi.fn() },
    clientAccount: { findUnique: vi.fn() },
  },
}));

vi.mock("../../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

import { optionalClientAuth } from "../../src/middleware/auth.js";

function runMiddleware(req) {
  return new Promise((resolve) => {
    const res = {
      status: vi.fn((code) => {
        resolve({ kind: "status", code, res });
        return res;
      }),
      json: vi.fn(),
    };
    const next = vi.fn(() => resolve({ kind: "next", req }));
    optionalClientAuth(req, res, next);
  });
}

describe("optionalClientAuth (guest booking)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes guests through without setting req.client", async () => {
    const req = { headers: {} };
    const { kind } = await runMiddleware(req);
    expect(kind).toBe("next");
    expect(req.client).toBeUndefined();
  });

  it("links a valid client session to req.client", async () => {
    mockPrisma.clientSession.findFirst.mockResolvedValue({ clientId: "cl-1" });
    mockPrisma.clientAccount.findUnique.mockResolvedValue({
      id: "cl-1",
      email: "owner@example.com",
      fullName: "Owner",
      suspended: false,
    });
    const req = { headers: { authorization: "Bearer valid-token" } };
    const { kind } = await runMiddleware(req);
    expect(kind).toBe("next");
    expect(req.client).toMatchObject({ id: "cl-1", email: "owner@example.com" });
  });

  it("treats an invalid or expired token as a guest", async () => {
    mockPrisma.clientSession.findFirst.mockResolvedValue(null);
    const req = { headers: { authorization: "Bearer expired" } };
    const { kind } = await runMiddleware(req);
    expect(kind).toBe("next");
    expect(req.client).toBeUndefined();
  });

  it("treats a suspended client as a guest", async () => {
    mockPrisma.clientSession.findFirst.mockResolvedValue({ clientId: "cl-2" });
    mockPrisma.clientAccount.findUnique.mockResolvedValue({ id: "cl-2", suspended: true });
    const req = { headers: { authorization: "Bearer token" } };
    const { kind } = await runMiddleware(req);
    expect(kind).toBe("next");
    expect(req.client).toBeUndefined();
  });

  it("returns 500 on a database error", async () => {
    mockPrisma.clientSession.findFirst.mockRejectedValue(new Error("db down"));
    const req = { headers: { authorization: "Bearer token" } };
    const { kind, code } = await runMiddleware(req);
    expect(kind).toBe("status");
    expect(code).toBe(500);
  });
});
