import { prisma } from "./prisma.js";

/**
 * Create a broadcast notification visible to all staff.
 * Returns the created notification or null on failure.
 */
export async function createBroadcastNotification(tx, { type, title, body, data }) {
  try {
    return await tx.notification.create({
      data: { type, title, body, data: data ?? undefined, readBy: [] },
    });
  } catch {
    return null;
  }
}
