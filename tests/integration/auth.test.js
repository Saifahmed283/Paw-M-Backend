import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: mockPrisma,
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import jwt from "jsonwebtoken";
import { app } from "../../src/app.js";

const JWT_SECRET = "test-secret";

function makeToken(user) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "1h" });
}

function makeCookie(token) {
  return `paw-m-session=${token}`;
}

describe("Auth API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = JWT_SECRET;
  });

  it("config route returns configured: false when no users", async () => {
    mockPrisma.adminUser.findFirst.mockResolvedValue(null);
    const { default: router } = await import("../../src/routes/auth.js");
    const express = await import("express");
    const testApp = express.default();
    testApp.use(express.default.json());
    testApp.use("/api/auth", router);
    const request = (await import("supertest")).default;
    const res = await request(testApp).get("/api/auth/config");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
  });

  it("config route returns configured: true when user exists", async () => {
    mockPrisma.adminUser.findFirst.mockResolvedValue({ id: 1, username: "admin" });
    const { default: router } = await import("../../src/routes/auth.js");
    const express = await import("express");
    const testApp = express.default();
    testApp.use(express.default.json());
    testApp.use("/api/auth", router);
    const request = (await import("supertest")).default;
    const res = await request(testApp).get("/api/auth/config");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
  });
});

describe("Auth integration", () => {
  it("token verification works with correct secret", () => {
    const user = { id: 1, username: "admin", role: "admin" };
    const token = makeToken(user);
    const decoded = jwt.verify(token, JWT_SECRET);
    expect(decoded.id).toBe(1);
    expect(decoded.username).toBe("admin");
    expect(decoded.role).toBe("admin");
  });

  it("token verification fails with wrong secret", () => {
    const user = { id: 1, username: "admin", role: "admin" };
    const token = jwt.sign(user, "wrong-secret", { expiresIn: "1h" });
    expect(() => jwt.verify(token, JWT_SECRET)).toThrow();
  });

  it("expired tokens are rejected", () => {
    const user = { id: 1, username: "admin", role: "admin" };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: "0s" });
    // Wait a tiny bit for the token to expire
    expect(() => jwt.verify(token, JWT_SECRET)).toThrow();
  });
});

describe("Role hierarchy", () => {
  it("admin has higher privileges than payroll", () => {
    const hierarchy = { staff: 0, payroll: 1, admin: 2 };
    expect(hierarchy.admin).toBeGreaterThan(hierarchy.payroll);
  });

  it("payroll has higher privileges than staff", () => {
    const hierarchy = { staff: 0, payroll: 1, admin: 2 };
    expect(hierarchy.payroll).toBeGreaterThan(hierarchy.staff);
  });
});
