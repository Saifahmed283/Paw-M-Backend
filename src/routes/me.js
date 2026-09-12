import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { authenticateClient } from "../middleware/auth.js";

const router = Router();
const log = logger.child({ module: "routes/me" });

router.get("/", authenticateClient, async (req, res) => {
  const clientId = req.client.id;
  try {
    const [client, pets, bookings, orders, prescriptions] = await Promise.all([
      prisma.clientAccount.findUnique({
        where: { id: clientId },
        select: { id: true, email: true, fullName: true, phone: true, createdAt: true },
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
    ]);
    res.json({ client, pets, bookings, orders, prescriptions });
  } catch (e) {
    log.error({ err: e }, "failed to fetch client profile");
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

export default router;