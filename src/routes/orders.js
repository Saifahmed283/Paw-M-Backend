import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit, nextId, fawryReference } from "../lib/utils.js";
import { validateProofImage } from "../services/orders.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireStaff, authenticateClient, authenticateClientOrStaff, optionalClientOrStaff } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createOrderSchema, updateOrderStatusSchema, updateOrderPaymentSchema, submitPaymentProofSchema, refundOrderSchema } from "../schemas/orders.js";
import { createOrderTransactional, restoreStockOnCancel, computeRefundPlan } from "../services/orders.js";
import { syncOrderPaymentStatus } from "../services/payment-status.js";
import { createBroadcastNotification } from "../lib/notify.js";
import { attributeSaleToActiveSession } from "../services/session-attribution.js";

const router = Router();
const log = logger.child({ module: "routes/orders" });
const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

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

router.post("/", optionalClientOrStaff, validate(createOrderSchema), async (req, res) => {
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
        // Price overrides / discounts for POS sales are only trusted when the
        // request is authenticated as staff (req.user). A store customer may
        // send source:"pos" but never gains override powers.
        const isPos = Boolean(req.user) && body.source === "pos";
        const { total, lines, discountAmount, discountLabel } = await createOrderTransactional(tx, body, isPos);
        const proofRef = (body.paymentRef || "").trim();
        const isCash = paymentMethod === "cash";
        const needsProof = paymentMethod === "instapay" || paymentMethod === "fawry";
        const hasProof = Boolean(proofRef) || Boolean(proofImage);
        // Cash is settled on the spot. InstaPay/Fawry are only done after staff
        // reviews the submitted proof; with proof attached they enter review.
        const paymentStatus = isCash ? "paid" : needsProof && hasProof ? "proof_submitted" : "unpaid";

        const order = await tx.order.create({
          data: {
            id: await nextId("ORD", "order"),
            clientId: req.client?.id ?? null,
            customerName: body.customerName,
            phone: body.phone,
            email: body.email,
            address: body.address,
            items: lines,
            total,
            status: isCash ? "confirmed" : "pending",
            paymentMethod,
            paymentStatus,
            paidAt: isCash ? new Date() : null,
            // Keep a customer-supplied Fawry voucher; generate a reference only
            // when they have not provided one (the old flow discarded both the
            // ref and the proof image for Fawry).
            paymentRef: paymentMethod === "fawry" && !proofRef ? fawryReference() : proofRef.slice(0, 120),
            proofImage: needsProof ? proofImage.slice(0, 8_000_000) : "",
            source: isPos ? "pos" : "store",
            discountAmount,
            discountLabel,
          },
        });

        // Every sale produces a categorized Payment row so Finance collects from
        // one source of truth. Cash is already paid; other methods are pending
        // and become paid when staff confirm them.
        const paymentItems = lines.map((line) => ({
          label: `${line.qty}x ${line.name}`.slice(0, 200),
          amount: Math.round(line.price * line.qty * 100) / 100,
          kind: line.id.startsWith("service-") ? "service" : "product",
          referenceId: line.id.slice(0, 60),
        }));
        if (discountAmount > 0) {
          paymentItems.push({
            label: (discountLabel || "Discount").slice(0, 200),
            amount: -Math.round(discountAmount * 100) / 100,
            kind: "other",
            referenceId: "",
          });
        }
        await tx.payment.create({
          data: {
            id: await nextId("PAY", "payment"),
            title: `${isPos ? "POS" : "Store"} — ${order.customerName}`.slice(0, 200),
            amount: total,
            method: paymentMethod,
            status: paymentStatus,
            date: localDate(),
            notes: isPos ? "Point of sale" : "Store checkout",
            orderId: order.id,
            kind: "order",
            requestedBy: req.user?.username ?? "",
            items: { create: paymentItems },
          },
        });

        return order;
      },
      { timeout: 15000 }
    );
    createBroadcastNotification(prisma, {
      type: "order",
      title: "New order received",
      body: `${created.customerName} placed an order for EGP ${created.total.toLocaleString()}.`,
      data: { orderId: created.id },
    }).catch(() => {});

    // Confirm the order immediately (not just on later staff status changes).
    if (created.email) {
      import("../lib/email.js").then(async ({ sendMail, buildOrderPlacedEmail }) => {
        const clinicSettings = await prisma.clinicSettings.findUnique({ where: { id: 1 } }).catch(() => null);
        const clinicName = clinicSettings?.name || "Paw-M Clinic";
        await sendMail(buildOrderPlacedEmail({
          to: created.email,
          customerName: created.customerName,
          orderId: created.id,
          total: created.total,
          paymentMethod: created.paymentMethod,
          paymentRef: created.paymentMethod !== "cash" ? created.paymentRef : "",
          clinicName,
        }));
      }).catch(() => {});
    }

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

// Staff-only refunds. The order itself is the invoice: refunds are allowed for
// any settled sale, so paymentStatus is deliberately not checked here.
router.post("/:id/refund", authenticateUser, requireStaff, validate(refundOrderSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { reason, items } = req.validated.body;
  const username = req.user?.username ?? "";
  try {
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return res.status(404).json({ error: "Order not found" });

    const { refundId, plan } = await prisma.$transaction(
      async (tx) => {
        // Read prior refunds inside the transaction so two concurrent refunds
        // cannot both consume the same remaining quantity.
        const payments = await tx.payment.findMany({
          where: { orderId: id, kind: "refund" },
          include: { items: true },
        });
        const refundPlan = computeRefundPlan(order, payments, items);
        const refundPaymentId = await nextId("PAY", "payment");

        await tx.payment.create({
          data: {
            id: refundPaymentId,
            title: `Refund ${order.id}`,
            amount: -refundPlan.refundedAmount,
            method: order.paymentMethod,
            status: "paid",
            date: localDate(),
            notes: reason,
            orderId: order.id,
            kind: "refund",
            requestedBy: username,
          },
        });

        for (const line of refundPlan.refundedLines) {
          await tx.paymentItem.create({
            data: {
              paymentId: refundPaymentId,
              label: `${line.qty}x ${line.name}`,
              amount: -line.amount,
              kind: line.kind,
              referenceId: line.id,
            },
          });

          if (line.kind !== "product") continue;
          const product = await tx.product.findUnique({
            where: { id: line.id },
            select: { id: true, name: true, stock: true },
          });
          if (!product) continue; // product was deleted — no stock to restore
          await tx.product.updateMany({
            where: { id: line.id },
            data: { stock: { increment: line.qty } },
          });
          await tx.stockMovement.create({
            data: {
              productId: line.id,
              productName: product.name,
              type: "return",
              qtyChange: line.qty,
              qtyBefore: product.stock,
              qtyAfter: product.stock + line.qty,
              relatedOrderId: order.id,
              note: `Refund ${order.id}${reason ? ` — ${reason}` : ""}`,
              changedBy: username,
            },
          });
        }

        return { refundId: refundPaymentId, plan: refundPlan };
      },
      { timeout: 15000 }
    );

    logAudit(
      "order_refund",
      id,
      `Refunded ${plan.refundedAmount} on order ${id} (${plan.refundedLines.length} line(s))${reason ? ` — ${reason}` : ""} by ${username || "unknown"}`
    );
    res.json({
      orderId: id,
      refundId,
      refundedAmount: plan.refundedAmount,
      refundedLines: plan.refundedLines.map(({ id: lineId, name, qty, amount, kind }) => ({
        id: lineId, name, qty, amount, kind,
      })),
      remainingRefundable: plan.remainingRefundable,
      fullyRefunded: plan.fullyRefunded,
    });
  } catch (e) {
    if (e?.status === 400 || e?.status === 409) {
      return res.status(e.status).json({ error: e.message });
    }
    log.error({ err: e }, "failed to refund order");
    res.status(500).json({ error: "Failed to refund order" });
  }
});

router.post("/:id/payment-proof", optionalClientOrStaff, validate(submitPaymentProofSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { paymentRef: rawRef, proofImage: rawImage, phone } = req.validated.body;
  const paymentRef = rawRef.trim();
  const proofImage = rawImage.trim();
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
    if (existing.paymentMethod === "cash") {
      return res.status(400).json({ error: "Cash orders are paid at checkout — no proof is needed." });
    }
    if (existing.paymentStatus === "proof_submitted" && !req.user) {
      return res.status(409).json({ error: "Proof is already under review." });
    }

    // Staff may act on any order. A signed-in client must own the order. A
    // guest proves ownership the same way as the public tracker: order id +
    // phone. This keeps the customer-facing proof flow working without
    // exposing other customers' orders.
    if (!req.user && req.client && existing.clientId !== req.client.id) {
      return res.status(403).json({ error: "You can only submit proof for your own order." });
    }
    if (!req.user && !req.client) {
      if (!phone || String(phone).trim() !== existing.phone) {
        return res.status(403).json({ error: "Phone number does not match this order." });
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { id },
        data: {
          paymentRef: paymentRef || existing.paymentRef,
          proofImage: proofImage || existing.proofImage,
          paymentStatus: "proof_submitted",
        },
      });
      await syncOrderPaymentStatus(tx, order, "proof_submitted");
      return order;
    }, { timeout: 15000 });
    logAudit("order_proof", id, `Payment proof submitted for ${updated.customerName}'s order`);
    res.json(updated);
  } catch (e) {
    if (e?.status === 400) return res.status(400).json({ error: e.message });
    log.error({ err: e }, "failed to submit payment proof");
    res.status(500).json({ error: "Failed to submit payment proof" });
  }
});

router.patch("/:id/payment", authenticateUser, requireStaff, validate(updateOrderPaymentSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { paymentStatus, paymentMethod } = req.validated.body;
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    if (paymentStatus === "paid") {
      if (existing.status === "cancelled") {
        return res.status(400).json({ error: "A cancelled order cannot be marked as paid." });
      }
      // InstaPay/Fawry must carry proof before staff can finish verification.
      if (existing.paymentMethod !== "cash" && existing.paymentStatus === "unpaid" && !existing.paymentRef && !existing.proofImage) {
        return res.status(400).json({ error: "Payment proof has not been submitted yet." });
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { id },
        data: {
          paymentStatus,
          ...(paymentMethod ? { paymentMethod } : {}),
          paidAt: paymentStatus === "paid" ? (existing.paidAt ?? new Date()) : null,
          ...(paymentStatus === "paid" && existing.status === "pending" ? { status: "confirmed" } : {}),
        },
      });
      await syncOrderPaymentStatus(tx, order, paymentStatus, { method: order.paymentMethod });
      return order;
    }, { timeout: 15000 });
    logAudit("order_payment", id, `Order ${updated.customerName} marked ${paymentStatus} (${updated.paymentMethod})`);

    const { sendMail, buildPaymentSuccessEmail, buildPaymentFailedEmail } = await import("../lib/email.js");
    if (existing.email) {
      const clinicSettings = await prisma.clinicSettings.findUnique({ where: { id: 1 } }).catch(() => null);
      const clinicName = clinicSettings?.name || "Paw-M Clinic";
      if (paymentStatus === "paid" && existing.paymentStatus !== "paid") {
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
  } catch (e) {
    if (e?.status === 400) return res.status(400).json({ error: e.message });
    log.error({ err: e }, "failed to update order payment status");
    res.status(500).json({ error: "Failed to update order payment status" });
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
