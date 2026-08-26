import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createNotificationSchema } from "../schemas/notifications.js";

const router = Router();
const log = logger.child({ module: "routes/notifications" });

router.get("/me", authenticateUser, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: {
        OR: [
          { targetUserId: req.user.id },
          { targetUserId: null },
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    res.json(notifications);
  } catch (error) {
    log.error({ err: error }, "failed to fetch notifications");
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

router.patch("/:id/read", authenticateUser, async (req, res) => {
  try {
    const notification = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!notification) return res.status(404).json({ error: "Notification not found" });
    const readBy = notification.readBy || [];
    const userIdStr = req.user.id.toString();
    if (!readBy.includes(userIdStr)) {
      readBy.push(userIdStr);
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
