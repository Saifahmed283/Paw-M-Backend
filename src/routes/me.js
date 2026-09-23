import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { authenticateClient } from "../middleware/auth.js";

const router = Router();
const log = logger.child({ module: "routes/me" });

router.patch("/notifications/:id/read", authenticateClient, async (req, res) => {
  const clientId = req.client.id;
  try {
    const existing = await prisma.clientNotification.findFirst({
      where: { id: req.params.id, clientId },
    });
    if (!existing) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    const updated = await prisma.clientNotification.update({
      where: { id: existing.id },
      data: { isRead: true },
    });
    res.json(updated);
  } catch (e) {
    log.error({ err: e }, "failed to mark notification read");
    res.status(500).json({ error: "Failed to update notification" });
  }
});

router.get("/", authenticateClient, async (req, res) => {
  const clientId = req.client.id;
  try {
    const [client, pets, bookings, orders, prescriptions, payments, notifications] =
      await Promise.all([
        prisma.clientAccount.findUnique({
          where: { id: clientId },
          select: { id: true, email: true, fullName: true, phone: true, suspended: true, createdAt: true },
        }),
        prisma.pet.findMany({ where: { clientId }, orderBy: { createdAt: "desc" } }),
        prisma.booking.findMany({
          where: { clientId },
          orderBy: { createdAt: "desc" },
          include: {
            pet: { select: { id: true, name: true, species: true } },
          },
        }),
        prisma.order.findMany({ where: { clientId }, orderBy: { createdAt: "desc" } }),
        prisma.prescription.findMany({
          where: { clientId },
          orderBy: { createdAt: "desc" },
          include: {
            pet: { select: { id: true, name: true, species: true } },
            doctor: { select: { id: true, name: true, title: true, specialization: true } },
          },
        }),
        prisma.payment.findMany({
          where: { clientId },
          orderBy: { createdAt: "desc" },
          include: { items: { orderBy: { createdAt: "asc" } } },
        }),
        prisma.clientNotification.findMany({
          where: { clientId },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
      ]);
    res.json({ client, pets, bookings, orders, prescriptions, payments, notifications });
  } catch (e) {
    log.error({ err: e }, "failed to fetch client profile");
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

export default router;