import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit, nextId, fawryReference } from "../lib/utils.js";
import { validateProofImage } from "../services/orders.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireStaff, authenticateClient, authenticateClientOrStaff } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createOrderSchema, updateOrderStatusSchema, updateOrderPaymentSchema } from "../schemas/orders.js";
import { createOrderTransactional, restoreStockOnCancel } from "../services/orders.js";
import { createBroadcastNotification } from "../lib/notify.js";
import { attributeSaleToActiveSession } from "../services/session-attribution.js";

const router = Router();
const log = logger.child({ module: "routes/orders" });

router.get("/", authenticateUser, requireStaff, async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const [orders, total] = await Promise.all([
      prisma.order.findMany({ orderBy: { createdAt: "desc" }, skip: p.skip, take: p.limit }),
      prisma.order.count(),
    ]);
    res.json(paginatedResponse(orders, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to fetch orders");
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

router.get("/track", async (req, res) => {
  const { orderId, phone } = req.query;
  if (!orderId || !phone) return res.status(400).json({ error: "orderId and phone are required" });
  try {
    const order = await prisma.order.findFirst({
      where: { id: String(orderId), phone: String(phone).trim() },
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (e) {
    log.error({ err: e }, "failed to look up order");
    res.status(500).json({ error: "Failed to look up order" });
  }
});

router.post("/", authenticateClientOrStaff, validate(createOrderSchema), async (req, res) => {
  const body = req.validated.body;
  const paymentMethod = body.paymentMethod;
  try {
    const proofImage = body.proofImage || "";
    if (proofImage.length > 0) {
      const check = validateProofImage(proofImage);
      if (!check.valid) return res.status(400).json({ error: check.error });
    }

    const created = await prisma.$transaction(
      async (tx) => {
        const { total, lines } = await createOrderTransactional(tx, body);
        const proofRef = (body.paymentRef || "").trim();
        const isInstaPay = paymentMethod === "instapay";
        const hasProof = Boolean(proofRef) || Boolean(proofImage);
        const paymentStatus = paymentMethod === "fawry" ? "unpaid" : isInstaPay && hasProof ? "proof_submitted" : "unpaid";

        return tx.order.create({
          data: {
            id: await nextId("ORD", "order"),
            customerName: body.customerName,
            phone: body.phone,
            email: body.email,
            address: body.address,
            items: lines,
            total,
            paymentMethod,
            paymentStatus,
            paymentRef: paymentMethod === "fawry" ? fawryReference() : proofRef.slice(0, 120),
            proofImage: isInstaPay ? proofImage.slice(0, 8_000_000) : "",
          },
        });
      },
      { timeout: 15000 }
    );
    createBroadcastNotification(prisma, {
      type: "order",
      title: "New order received",
      body: `${created.customerName} placed an order for EGP ${created.total.toLocaleString()}.`,
      data: { orderId: created.id },
    }).catch(() => {});

    attributeSaleToActiveSession(req, { orders: 1, revenue: created.total }).catch(() => {});

    res.status(201).json(created);
  } catch (e) {
    if (e?.status === 400 || e?.status === 409) {
      return res.status(e.status).json({ error: e.message });
    }
    log.error({ err: e }, "failed to create order");
    res.status(500).json({ error: "Failed to create order" });
  }
});

router.post("/:id/payment-proof", authenticateUser, requireStaff, async (req, res) => {
  const { id } = req.params;
  const body = req.body ?? {};
  const paymentRef = String(body.paymentRef ?? "").trim();
  const proofImage = String(body.proofImage ?? "").trim();
  if (!paymentRef && !proofImage) {
    return res.status(400).json({ error: "Provide a transaction reference or a proof image." });
  }
  if (proofImage.length > 0) {
    const check = validateProofImage(proofImage);
    if (!check.valid) return res.status(400).json({ error: check.error });
  }
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    if (existing.paymentStatus === "paid") {
      return res.status(400).json({ error: "This order is already marked as paid." });
    }
    const updated = await prisma.order.update({
      where: { id },
      data: {
        paymentRef: paymentRef || existing.paymentRef,
        proofImage: proofImage || existing.proofImage,
        paymentStatus: "proof_submitted",
      },
    });
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Order not found" });
  }
});

router.patch("/:id/payment", authenticateUser, requireStaff, validate(updateOrderPaymentSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { paymentStatus } = req.validated.body;
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    const updated = await prisma.order.update({
      where: { id },
      data: { paymentStatus, paidAt: paymentStatus === "paid" ? new Date() : null },
    });
    logAudit("order_payment", id, `Order ${updated.customerName} marked ${paymentStatus} (${updated.paymentMethod})`);

    const { sendMail, buildPaymentSuccessEmail, buildPaymentFailedEmail } = await import("../lib/email.js");
    if (existing.email) {
      const clinicSettings = await prisma.clinicSettings.findUnique({ where: { id: 1 } }).catch(() => null);
      const clinicName = clinicSettings?.name || "Paw-M Clinic";
      if (paymentStatus === "paid") {
        sendMail(buildPaymentSuccessEmail({
          to: existing.email, customerName: updated.customerName, orderId: updated.id,
          amount: updated.total, method: updated.paymentMethod, clinicName,
        })).catch(() => {});
      } else if (paymentStatus === "unpaid" && existing.paymentStatus === "proof_submitted") {
        sendMail(buildPaymentFailedEmail({
          to: existing.email, customerName: updated.customerName, orderId: updated.id,
          method: updated.paymentMethod, clinicName,
          reason: "Payment proof was not accepted or payment could not be verified.",
        })).catch(() => {});
      }
    }
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Order not found" });
  }
});

router.patch("/:id/status", authenticateUser, requireStaff, validate(updateOrderStatusSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { status } = req.validated.body;
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Order not found" });

    const updated = await prisma.$transaction(
      async (tx) => {
        if (status === "cancelled" && existing.status !== "cancelled") {
          await restoreStockOnCancel(tx, existing.items);
        }
        return tx.order.update({ where: { id }, data: { status } });
      },
      { timeout: 15000 }
    );
    logAudit("order_status", id, `${existing.customerName}'s order → ${status}`);

    if (existing.email && status !== existing.status) {
      const { sendMail, buildOrderStatusEmail } = await import("../lib/email.js");
      const clinicSettings = await prisma.clinicSettings.findUnique({ where: { id: 1 } }).catch(() => null);
      const clinicName = clinicSettings?.name || "Paw-M Clinic";
      sendMail(buildOrderStatusEmail({
        to: existing.email, customerName: existing.customerName, orderId: existing.id,
        status, clinicName, total: existing.total, items: existing.items,
      })).catch(() => {});
    }
    res.json(updated);
  } catch (e) {
    if (e?.status === 400 || e?.status === 409) {
      return res.status(e.status).json({ error: e.message });
    }
    log.error({ err: e }, "failed to update order status");
    res.status(500).json({ error: "Failed to update order status" });
  }
});

router.delete("/:id", authenticateUser, requireStaff, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    await prisma.order.delete({ where: { id } });
    logAudit("order_delete", id, `Deleted order for ${existing?.customerName ?? "unknown"}`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Order not found" });
  }
});

router.patch("/:id/archive", authenticateUser, requireStaff, async (req, res) => {
  const { id } = req.params;
  const archived = req.body?.archived === true;
  try {
    const updated = await prisma.order.update({ where: { id }, data: { archived } });
    logAudit(archived ? "order_archive" : "order_restore", id, `${updated.customerName}'s order ${archived ? "archived" : "restored"}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Order not found" });
  }
});

export default router;
