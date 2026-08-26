import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit, nextId } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireStaff } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createPaymentSchema, updatePaymentSchema } from "../schemas/payments.js";

const router = Router();
const log = logger.child({ module: "routes/payments" });

router.get("/", authenticateUser, requireStaff, async (_req, res) => {
  try {
    const payments = await prisma.payment.findMany({ orderBy: { createdAt: "desc" } });
    res.json(payments);
  } catch {
    res.status(500).json({ error: "Failed to load payments" });
  }
});

router.post("/", authenticateUser, requireStaff, validate(createPaymentSchema), async (req, res) => {
  const body = req.validated.body;
  try {
    const created = await prisma.payment.create({
      data: {
        id: await nextId("PAY", "payment"),
        title: body.title,
        amount: Math.round(body.amount * 100) / 100,
        method: body.method,
        status: body.status,
        date: body.date,
        notes: body.notes,
        orderId: body.orderId,
      },
    });
    logAudit("payment_create", created.id, `Recorded ${created.method} payment "${created.title}" (${created.status})`);
    res.status(201).json(created);
  } catch {
    res.status(500).json({ error: "Failed to create payment" });
  }
});

router.patch("/:id", authenticateUser, requireStaff, validate(updatePaymentSchema), async (req, res) => {
  const { id } = req.validated.params;
  const patch = req.validated.body;
  try {
    if (patch.amount !== undefined) patch.amount = Math.round(patch.amount * 100) / 100;
    const updated = await prisma.payment.update({ where: { id }, data: patch });
    logAudit("payment_update", id, `Updated payment "${updated.title}"`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Payment not found" });
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
