import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit, nextId, todayStr } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireStaff } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  addPaymentItemsSchema,
  createPaymentSchema,
  settlePaymentSchema,
  updatePaymentSchema,
} from "../schemas/payments.js";

const router = Router();
const log = logger.child({ module: "routes/payments" });

const paymentInclude = {
  client: { select: { id: true, fullName: true, phone: true, email: true } },
  booking: { select: { id: true, petName: true, doctorName: true, date: true, status: true } },
  items: { orderBy: { createdAt: "asc" } },
};

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

router.get("/", authenticateUser, requireStaff, async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const where = {};
    if (req.query.kind) where.kind = String(req.query.kind);
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.clientId) where.clientId = String(req.query.clientId);
    if (req.query.bookingId) where.bookingId = String(req.query.bookingId);
    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: p.skip,
        take: p.limit,
        include: paymentInclude,
      }),
      prisma.payment.count({ where }),
    ]);
    res.json(paginatedResponse(payments, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to load payments");
    res.status(500).json({ error: "Failed to load payments" });
  }
});

router.post("/", authenticateUser, requireStaff, validate(createPaymentSchema), async (req, res) => {
  const body = req.validated.body;
  try {
    const data = {
      id: await nextId("PAY", "payment"),
      title: body.title,
      method: body.method,
      status: body.status,
      date: body.date ?? todayStr(),
      notes: body.notes,
      orderId: body.orderId,
      clientId: body.clientId ?? null,
      bookingId: body.bookingId ?? null,
      kind: body.kind,
      requestedBy: body.requestedBy ?? "",
    };

    if (body.kind === "visit" && body.bookingId) {
      const booking = await prisma.booking.findUnique({
        where: { id: body.bookingId },
        select: { id: true, clientId: true, petName: true, doctorName: true },
      });
      if (!booking) {
        return res.status(400).json({ error: "Booking not found" });
      }
      if (!data.clientId) data.clientId = booking.clientId;
      if (!data.requestedBy) data.requestedBy = req.user?.username ?? "";
    }

    const items = Array.isArray(body.items) ? body.items : [];
    const itemTotal = round2(items.reduce((sum, it) => sum + Number(it.amount || 0), 0));
    data.amount = round2(body.amount ?? itemTotal ?? 0);
    if (data.amount <= 0) {
      return res.status(400).json({ error: "Amount must be positive" });
    }

    const created = await prisma.payment.create({
      data: {
        ...data,
        amount: data.amount,
        items: items.length
          ? {
              create: items.map((it) => ({
                label: it.label,
                amount: round2(it.amount),
                kind: it.kind,
                referenceId: it.referenceId ?? "",
              })),
            }
          : undefined,
      },
      include: paymentInclude,
    });
    logAudit(
      "payment_create",
      created.id,
      `Recorded ${created.method} "${created.title}" (${created.status}, ${created.kind}) — ${created.amount}`
    );
    res.status(201).json(created);
  } catch (e) {
    log.error({ err: e }, "failed to create payment");
    res.status(500).json({ error: "Failed to create payment" });
  }
});

router.patch("/:id", authenticateUser, requireStaff, validate(updatePaymentSchema), async (req, res) => {
  const { id } = req.validated.params;
  const patch = req.validated.body;
  try {
    if (patch.amount !== undefined) patch.amount = round2(patch.amount);
    const updated = await prisma.payment.update({
      where: { id },
      data: patch,
      include: paymentInclude,
    });
    logAudit("payment_update", id, `Updated payment "${updated.title}"`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Payment not found" });
  }
});

router.post("/:id/items", authenticateUser, requireStaff, validate(addPaymentItemsSchema), async (req, res) => {
  const { id } = req.validated.params;
  const items = req.validated.body.items;
  try {
    const existing = await prisma.payment.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Payment not found" });
    if (existing.status === "paid") {
      return res.status(400).json({ error: "Cannot add items to a settled payment" });
    }
    const addedTotal = round2(items.reduce((sum, it) => sum + Number(it.amount || 0), 0));
    await prisma.paymentItem.createMany({
      data: items.map((it) => ({
        paymentId: id,
        label: it.label,
        amount: round2(it.amount),
        kind: it.kind,
        referenceId: it.referenceId ?? "",
      })),
    });
    const updated = await prisma.payment.update({
      where: { id },
      data: { amount: round2(existing.amount + addedTotal) },
      include: paymentInclude,
    });
    logAudit("payment_add_items", id, `Added ${items.length} line item(s) (+${addedTotal})`);
    res.json(updated);
  } catch (e) {
    log.error({ err: e }, "failed to add payment items");
    res.status(500).json({ error: "Failed to add payment items" });
  }
});

router.post("/:id/settle", authenticateUser, requireStaff, validate(settlePaymentSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { method, notes } = req.validated.body;
  try {
    const existing = await prisma.payment.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!existing) return res.status(404).json({ error: "Payment not found" });
    if (existing.status === "paid") {
      return res.status(400).json({ error: "Payment is already settled" });
    }
    const fromItems = round2(existing.items.reduce((sum, it) => sum + Number(it.amount || 0), 0));
    const amount = fromItems > 0 ? fromItems : round2(existing.amount);
    const updated = await prisma.payment.update({
      where: { id },
      data: {
        status: "paid",
        method: method ?? existing.method,
        amount,
        notes: [existing.notes, notes].filter(Boolean).join("\n").slice(0, 1000),
      },
      include: paymentInclude,
    });
    logAudit("payment_settle", id, `Settled "${updated.title}" (${updated.method}, ${updated.amount})`);
    res.json(updated);
  } catch (e) {
    log.error({ err: e }, "failed to settle payment");
    res.status(500).json({ error: "Failed to settle payment" });
  }
});

router.delete("/:id", authenticateUser, requireStaff, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.payment.findUnique({ where: { id } });
    await prisma.payment.delete({ where: { id } });
    logAudit("payment_delete", id, `Deleted payment "${existing?.title ?? "unknown"}"`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Payment not found" });
  }
});

export default router;