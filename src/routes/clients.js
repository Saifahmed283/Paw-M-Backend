import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireAdmin, requirePayrollOrAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createClientSchema, notifyClientSchema, updateClientSchema } from "../schemas/clients.js";
import { sendMail, buildClientNotifyEmail } from "../lib/email.js";
import { logAudit } from "../lib/utils.js";

const router = Router();
const log = logger.child({ module: "routes/clients" });

const petSelect = {
  id: true,
  name: true,
  species: true,
  breed: true,
  sex: true,
  dob: true,
  weightKg: true,
  color: true,
  photo: true,
  notes: true,
  createdAt: true,
};

export function classifyClient(bookingsCount, ordersCount) {
  if (bookingsCount > 0 && ordersCount > 0) return "both";
  if (bookingsCount > 0) return "clinic";
  if (ordersCount > 0) return "store";
  return "new";
}

async function activityMap(model, ids) {
  if (ids.length === 0) return new Map();
  const rows = await prisma[model].groupBy({
    by: ["clientId"],
    where: { clientId: { in: ids } },
    _max: { createdAt: true },
  });
  return new Map(rows.map((r) => [r.clientId, r._max.createdAt]));
}

router.post(
  "/",
  authenticateUser,
  requirePayrollOrAdmin,
  validate(createClientSchema),
  async (req, res) => {
    const { fullName, email, phone, password } = req.validated.body;
    try {
      const salt = crypto.randomBytes(16).toString("hex");
      const passwordHash = bcrypt.hashSync(password, 12);
      const client = await prisma.clientAccount.create({
        data: { fullName, email, phone: phone || "", passwordHash, salt },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          suspended: true,
          suspendedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      logAudit("client_create", client.id, `Created client ${client.fullName}`);
      res.status(201).json({
        ...client,
        type: "new",
        petsCount: 0,
        bookingsCount: 0,
        ordersCount: 0,
        totalPaid: 0,
        outstanding: 0,
        lastActivity: client.createdAt,
      });
    } catch (err) {
      if (err?.code === "P2002") {
        return res.status(409).json({ error: "An account with this email already exists." });
      }
      log.error({ err }, "failed to create client");
      res.status(500).json({ error: "Failed to create client" });
    }
  },
);

router.get("/", authenticateUser, requirePayrollOrAdmin, async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const q = String(req.query.q ?? "").trim();
    const where =
      q.length > 0
        ? {
            OR: [
              { fullName: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
            ],
          }
        : {};

    const [clients, total] = await Promise.all([
      prisma.clientAccount.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: p.skip,
        take: p.limit,
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          suspended: true,
          suspendedAt: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { pets: true, bookings: true, orders: true } },
        },
      }),
      prisma.clientAccount.count({ where }),
    ]);

    const ids = clients.map((c) => c.id);
    const [paidGroups, unpaidGroups, bookingActs, orderActs, paymentActs] = await Promise.all([
      prisma.payment.groupBy({
        by: ["clientId"],
        where: { clientId: { in: ids }, status: "paid" },
        _sum: { amount: true },
      }),
      prisma.payment.groupBy({
        by: ["clientId"],
        where: { clientId: { in: ids }, status: { not: "paid" } },
        _sum: { amount: true },
      }),
      activityMap("booking", ids),
      activityMap("order", ids),
      activityMap("payment", ids),
    ]);

    const paidByClient = new Map(paidGroups.map((g) => [g.clientId, g._sum.amount ?? 0]));
    const unpaidByClient = new Map(unpaidGroups.map((g) => [g.clientId, g._sum.amount ?? 0]));

    const data = clients.map((c) => {
      const bookingsCount = c._count.bookings;
      const ordersCount = c._count.orders;
      const lastActivity = [bookingActs.get(c.id), orderActs.get(c.id), paymentActs.get(c.id)]
        .filter(Boolean)
        .reduce((acc, d) => (acc && acc > d ? acc : d), null);
      return {
        id: c.id,
        fullName: c.fullName,
        email: c.email,
        phone: c.phone,
        suspended: c.suspended,
        suspendedAt: c.suspendedAt,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        type: classifyClient(bookingsCount, ordersCount),
        petsCount: c._count.pets,
        bookingsCount,
        ordersCount,
        totalPaid: paidByClient.get(c.id) ?? 0,
        outstanding: unpaidByClient.get(c.id) ?? 0,
        lastActivity: lastActivity ?? c.createdAt,
      };
    });

    res.json(paginatedResponse(data, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to load clients");
    res.status(500).json({ error: "Failed to load clients" });
  }
});

router.get("/:id", authenticateUser, requirePayrollOrAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const client = await prisma.clientAccount.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        suspended: true,
        suspendedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!client) return res.status(404).json({ error: "Client not found" });

    const [pets, bookings, prescriptions, orders, payments] = await Promise.all([
      prisma.pet.findMany({
        where: { clientId: id },
        orderBy: { createdAt: "desc" },
        select: petSelect,
      }),
      prisma.booking.findMany({
        where: { clientId: id },
        orderBy: [{ date: "asc" }, { time: "asc" }],
        include: {
          pet: { select: { id: true, name: true, species: true } },
          prescriptions: {
            select: { id: true, rxNumber: true, status: true, followUpDate: true, issuedAt: true },
          },
        },
      }),
      prisma.prescription.findMany({
        where: { clientId: id },
        orderBy: { createdAt: "desc" },
        include: {
          pet: { select: { id: true, name: true, species: true } },
          doctor: { select: { id: true, name: true, title: true, specialization: true } },
        },
      }),
      prisma.order.findMany({
        where: { clientId: id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          customerName: true,
          total: true,
          status: true,
          paymentStatus: true,
          paymentMethod: true,
          items: true,
          source: true,
          createdAt: true,
          paidAt: true,
        },
      }),
      prisma.payment.findMany({
        where: { clientId: id },
        orderBy: { createdAt: "desc" },
        include: {
          booking: { select: { id: true, petName: true, doctorName: true, date: true, status: true } },
          items: { orderBy: { createdAt: "asc" } },
        },
      }),
      prisma.clientAccount.aggregate({
        where: { id },
        _count: { _all: true },
      }),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const nextAppointment =
      bookings.find((b) => b.date >= today && (b.status === "pending" || b.status === "confirmed")) ?? null;
    const lastCompleted = [...bookings].reverse().find((b) => b.status === "completed" && b.followUpDate) ?? null;

    const paidVisit = payments.filter((p) => p.kind === "visit" && p.status === "paid").reduce((s, p) => s + p.amount, 0);
    const outstandingVisit = payments.filter((p) => p.kind === "visit" && p.status !== "paid").reduce((s, p) => s + p.amount, 0);

    res.json({
      client,
      pets,
      bookings,
      prescriptions,
      orders,
      payments,
      stats: {
        bookingsCount: bookings.length,
        completedCount: bookings.filter((b) => b.status === "completed").length,
        paidVisit,
        outstandingVisit,
        nextAppointment,
        followUpDate: lastCompleted?.followUpDate ?? "",
      },
    });
  } catch (e) {
    log.error({ err: e }, "failed to load client detail");
    res.status(500).json({ error: "Failed to load client detail" });
  }
});

// PATCH /api/clients/:id — suspend or re-activate a client account
router.patch(
  "/:id",
  authenticateUser,
  requireAdmin,
  validate(updateClientSchema),
  async (req, res) => {
    const { id } = req.params;
    const { suspended } = req.validated.body;
    try {
      const client = await prisma.clientAccount.findUnique({ where: { id } });
      if (!client) return res.status(404).json({ error: "Client not found" });

      const nextValue = suspended ?? client.suspended;
      const updated = await prisma.clientAccount.update({
        where: { id },
        data: {
          suspended: nextValue,
          suspendedAt: nextValue ? new Date() : null,
        },
        select: { id: true, fullName: true, email: true, suspended: true, suspendedAt: true },
      });

      // Invalidate any live sessions so a suspended client is signed out immediately.
      if (nextValue) {
        await prisma.clientSession.deleteMany({ where: { clientId: id } });
      }

      logAudit(
        nextValue ? "suspend_client" : "unsuspend_client",
        id,
        `${updated.fullName} ${nextValue ? "suspended" : "re-activated"} by ${req.user.username}`,
      );
      res.json(updated);
    } catch (e) {
      log.error({ err: e }, "failed to update client");
      res.status(500).json({ error: "Failed to update client" });
    }
  },
);

// DELETE /api/clients/:id — permanently delete a client account and its records
router.delete("/:id", authenticateUser, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const client = await prisma.clientAccount.findUnique({
      where: { id },
      select: { id: true, fullName: true, email: true },
    });
    if (!client) return res.status(404).json({ error: "Client not found" });

    await prisma.clientAccount.delete({ where: { id } });
    logAudit("delete_client", id, `${client.fullName} deleted by ${req.user.username}`);
    res.json({ success: true });
  } catch (e) {
    log.error({ err: e }, "failed to delete client");
    res.status(500).json({ error: "Failed to delete client" });
  }
});

// POST /api/clients/:id/notify — send an in-app + email message to the client
router.post(
  "/:id/notify",
  authenticateUser,
  requirePayrollOrAdmin,
  validate(notifyClientSchema),
  async (req, res) => {
    const { id } = req.params;
    const { title, body } = req.validated.body;
    try {
      const client = await prisma.clientAccount.findUnique({
        where: { id },
        select: { id: true, email: true, fullName: true, suspended: true },
      });
      if (!client) return res.status(404).json({ error: "Client not found" });
      if (client.suspended) {
        return res.status(400).json({ error: "Cannot notify a suspended client." });
      }

      const notification = await prisma.clientNotification.create({
        data: { clientId: id, title, body },
      });

      const mailResult = await sendMail(
        buildClientNotifyEmail({
          to: client.email,
          clientName: client.fullName,
          title,
          body,
          clinicName: "Paw-M Veterinary Clinic",
        }),
      );

      logAudit("notify_client", id, `${client.fullName} notified by ${req.user.username}`);
      res.status(201).json({ notification, mail: mailResult });
    } catch (e) {
      log.error({ err: e }, "failed to notify client");
      res.status(500).json({ error: "Failed to notify client" });
    }
  },
);

export default router;