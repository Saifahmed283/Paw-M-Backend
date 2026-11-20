import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: mockPrisma }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

import { config } from "../../src/config.js";
import { attributeSaleToActiveSession } from "../../src/services/session-attribution.js";

const OPEN_SESSION = {
  id: "session-1",
  employeeId: "emp-9",
  ordersCount: 2,
  bookingsCount: 1,
  revenueTotal: 100,
  commissionTotal: 10,
};

describe("attributeSaleToActiveSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.adminUser.findUnique.mockResolvedValue({
      username: "cashier",
      employeeId: "emp-9",
    });
    mockPrisma.workSession.findFirst.mockResolvedValue(OPEN_SESSION);
    mockPrisma.workSession.update.mockResolvedValue({ id: OPEN_SESSION.id });
  });

  it("uses req.user.id set by Bearer staff auth, without needing a cookie", async () => {
    const req = { user: { id: 42, username: "cashier", role: "staff" }, cookies: {} };

    const sessionId = await attributeSaleToActiveSession(req, {
      orders: 1,
      bookings: 2,
      revenue: 50,
      commission: 5,
    });

    expect(sessionId).toBe("session-1");
    expect(mockPrisma.adminUser.findUnique).toHaveBeenCalledWith({
      where: { id: 42 },
      select: { username: true, employeeId: true },
    });
    expect(mockPrisma.employee.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.workSession.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: {
        ordersCount: 3,
        bookingsCount: 3,
        revenueTotal: 150,
        commissionTotal: 15,
      },
    });
  });

  it("falls back to the staff JWT cookie when req.user is absent", async () => {
    const token = jwt.sign({ id: 77, username: "cashier", role: "staff" }, config.jwtSecret);
    const req = { cookies: { [config.cookieName]: token } };

    expect(await attributeSaleToActiveSession(req, { orders: 1 })).toBe("session-1");
    expect(mockPrisma.adminUser.findUnique).toHaveBeenCalledWith({
      where: { id: 77 },
      select: { username: true, employeeId: true },
    });
  });

  it("returns null without attributing when there is no valid staff identity", async () => {
    expect(await attributeSaleToActiveSession({ cookies: {} }, { orders: 1 })).toBeNull();
    expect(
      await attributeSaleToActiveSession({ cookies: { [config.cookieName]: "not-a-jwt" } }, {}),
    ).toBeNull();
    expect(mockPrisma.workSession.update).not.toHaveBeenCalled();
  });

  it("stays non-blocking when attribution fails", async () => {
    mockPrisma.adminUser.findUnique.mockRejectedValue(new Error("db down"));
    const req = { user: { id: 42 } };
    expect(await attributeSaleToActiveSession(req, { orders: 1 })).toBeNull();
  });
});
