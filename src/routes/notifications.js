import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { resolveEmployeeId } from "../lib/resolve-employee.js";
import { authenticateUser, requireAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createNotificationSchema } from "../schemas/notifications.js";

const router = Router();
const log = logger.child({ module: "routes/notifications" });

router.get("/me", authenticateUser, async (req, res) => {
  try {
    const employeeId = await resolveEmployeeId(req.user.id);
    const p = parsePagination(req.query);
    const where = employeeId
      ? { OR: [{ targetUserId: employeeId }, { targetUserId: null }] }
      : { targetUserId: null };
    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: p.skip,
        take: p.limit,
      }),
      prisma.notification.count({ where }),
    ]);
    const list = notifications.map((n) => ({
      ...n,
      isRead: Boolean(
        employeeId && Array.isArray(n.readBy) && n.readBy.includes(employeeId),
      ),
    }));
    res.json(paginatedResponse(list, total, p));
  } catch (error) {
    log.error({ err: error }, "failed to fetch notifications");
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

router.patch("/:id/read", authenticateUser, async (req, res) => {
  try {
    const employeeId = await resolveEmployeeId(req.user.id);
    if (!employeeId) return res.status(400).json({ error: "No employee profile found." });
    const notification = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!notification) return res.status(404).json({ error: "Notification not found" });
    const readBy = notification.readBy || [];
    if (!readBy.includes(employeeId)) {
      readBy.push(employeeId);
      await prisma.notification.update({ where: { id: req.params.id }, data: { readBy } });
    }
    res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, "failed to mark notification as read");
    res.status(500).json({ error: "Failed to mark notification as read" });
  }
});

router.post("/broadcast", authenticateUser, requireAdmin, validate(createNotificationSchema), async (req, res) => {
  try {
    const { type, title, body, data } = req.validated.body;
    const notification = await prisma.notification.create({
      data: { type, title, body, data: data || null, targetUserId: null, readBy: [] },
    });
    res.status(201).json(notification);
  } catch (error) {
    log.error({ err: error }, "failed to create notification");
    res.status(500).json({ error: "Failed to create notification" });
  }
});

export default router;
