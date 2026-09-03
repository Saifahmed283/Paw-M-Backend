import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { resolveEmployeeId } from "../lib/resolve-employee.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "session-attribution" });

/**
 * Best-effort attribution of a sale to the cashier's active work session.
 * When an order/booking is created by a logged-in staff/admin user (their admin
 * session cookie is present on the request), we resolve their employee profile
 * and increment that day's open (or most recent that-day) WorkSession counters.
 *
 * This is intentionally non-blocking: any failure is logged and the sale is
 * still completed. It never gates the request.
 *
 * @param {object} req  Express request (used to read the admin session cookie).
 * @param {{ orders?: number, bookings?: number, revenue?: number, commission?: number }} delta
 */
export async function attributeSaleToActiveSession(req, delta = {}) {
  try {
    const token = req.cookies?.[config.cookieName];
    if (!token) return null;

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch {
      return null; // not an admin session
    }

    const employeeId = await resolveEmployeeId(decoded.id);
    if (!employeeId) return null;

    const open = await prisma.workSession.findFirst({
      where: { employeeId, endedAt: null },
      orderBy: { startedAt: "desc" },
    });

    if (!open) return null;

    await prisma.workSession.update({
      where: { id: open.id },
      data: {
        ordersCount: open.ordersCount + (delta.orders ?? 0),
        bookingsCount: open.bookingsCount + (delta.bookings ?? 0),
        revenueTotal: (open.revenueTotal ?? 0) + (delta.revenue ?? 0),
        commissionTotal: (open.commissionTotal ?? 0) + (delta.commission ?? 0),
      },
    });

    return open.id;
  } catch (e) {
    log.error({ err: e }, "failed to attribute sale to active session");
    return null;
  }
}
