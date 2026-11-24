import { Router } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "../lib/prisma.js";
import { logAudit, nextId, todayStr } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireStaff, optionalClientOrStaff } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createOrderSchema,
  updateOrderStatusSchema,
  updateOrderPaymentSchema,
  submitPaymentProofSchema,
  refundOrderSchema,
  confirmCashSchema,
  transferSubmissionSchema,
} from "../schemas/orders.js";
import { createOrderTransactional, restoreStockOnCancel, computeRefundPlan } from "../services/orders.js";
import { syncOrderPaymentStatus } from "../services/payment-status.js";
import { confirmCashHandler, transferSubmissionHandler } from "./payment-verification.js";
import { createBroadcastNotification } from "../lib/notify.js";
import { attributeSaleToActiveSession } from "../services/session-attribution.js";

const router = Router();
const log = logger.child({ module: "routes/orders" });

// Fawry outlet receipts and InstaPay transfers both settle via submitted proof.
const PROOF_PAYMENT_METHODS = new Set(["fawry", "instapay"]);

// Eight attempts per quarter hour per client, independent of the broad /api/orders
// limiter. Overridable in tests via TRANSFER_SUBMISSION_RATE_MAX.
const transferLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => Number(process.env.TRANSFER_SUBMISSION_RATE_MAX ?? 8) || 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many transfer submissions. Try again in 15 minutes." },
});
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
  // A store customer may claim source:"pos" but never gains POS privileges.
  const isPos = Boolean(req.user) && body.source === "pos";
  if (body.cashReceived && !isPos) {
    return res.status(400).json({ error: "Cash reception may only be declared by authenticated POS staff." });
  }
  if (body.cashReceived && paymentMethod !== "cash") {
    return res.status(400).json({ error: "Cash reception is only valid for cash orders." });
  }
  try {
    const created = await prisma.$transaction(
      async (tx) => {
        const { total, lines, discountAmount, discountLabel } = await createOrderTransactional(tx, body, isPos);
        if (
          body.cashReceived &&
          Math.abs(Number(body.cashReceivedAmount ?? 0) - total) > 0.01
        ) {
          throw Object.assign(new Error("Cash received must match the order total."), { status: 400 });
        }
        // The ONLY trusted paid-at-checkout path: staff + POS + cash + exact
        // tendered amount. Every other order starts unpaid and is settled later
        // by confirm-cash or transfer approval.
        const posCashConfirmed = isPos &&
          paymentMethod === "cash" &&
          body.cashReceived === true &&
          Math.abs(Number(body.cashReceivedAmount ?? 0) - total) <= 0.01;
        const now = new Date();
        const paymentStatus = posCashConfirmed ? "paid" : "unpaid";

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
            status: posCashConfirmed ? "confirmed" : "pending",
            paymentMethod,
            paymentStatus,
            paidAt: posCashConfirmed ? now : null,
            paymentRef: "",
            proofImage: "",
            source: isPos ? "pos" : "store",
            discountAmount,
            discountLabel,
          },
        });

        if (posCashConfirmed) {
          await tx.paymentVerification.create({
            data: {
              orderId: order.id,
              method: "cash",
              amount: total,
              source: "cash_reception",
              decision: "approved",
              reviewerId: req.user.id,
              reviewedAt: now,
              createdAt: now,
              note: "Cash received at POS checkout",
            },
          });
        }

        // Every sale produces a categorized Payment row so Finance collects from
        // one source of truth. Its status mirrors the order's verification state.
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
        const payment = await tx.payment.create({
          data: {
            id: await nextId("PAY", "payment"),
            title: `${isPos ? "POS" : "Store"} — ${order.customerName}`.slice(0, 200),
            amount: total,
            method: paymentMethod,
            status: paymentStatus,
            date: todayStr(),
            notes: isPos ? "Point of sale" : "Store checkout",
            orderId: order.id,
            kind: "order",
            requestedBy: req.user?.username ?? "",
            items: { create: paymentItems },
          },
        });

        // Bank/outlet payments are not settled at checkout. Queue them for
        // review immediately: the cashier's "Settle bill" points staff at the
        // verification queue, which must contain the sale they just rung up.
        // A later customer proof submission supersedes this placeholder row.
        if (PROOF_PAYMENT_METHODS.has(paymentMethod)) {
          await tx.paymentVerification.create({
            data: {
              orderId: order.id,
              paymentId: payment.id,
              method: paymentMethod,
              amount: total,
              source: isPos ? "pos_transfer" : "store_transfer",
              decision: "submitted",
              note: isPos
                ? "POS sale awaiting bank-statement verification"
                : "Store order awaiting bank-statement verification",
            },
          });
        }

        return order;
      },
      { timeout: 15000 }
    );
    if (created.paymentStatus === "paid") {
      logAudit("cash_received_pos", created.id, `POS cash EGP ${created.total} received by staff #${req.user.id}`);
    }
    createBroadcastNotification(prisma, {
      type: "order",
      title: "New order received",
      body: `${created.customerName} placed an order for EGP ${created.total.toLocaleString()}.`,
      data: { orderId: created.id },
    }).catch(() => {});

    // Order-placed mail never claims payment was received: every checkout is
    // pending until cash is confirmed or a transfer is verified.
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
            date: todayStr(),
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

// ── Trusted verification entry points ────────────────────────────────────────
// Only these two handlers (plus POS cash reception above) may settle an order.
router.post("/:id/confirm-cash", authenticateUser, requireStaff, validate(confirmCashSchema), confirmCashHandler);
router.post("/:id/transfer-submission", optionalClientOrStaff, transferLimiter, validate(transferSubmissionSchema), transferSubmissionHandler);

// Deprecated compatibility shim: forwards to the proof-submission flow.
// Cash orders are rejected; the image is stored privately, never on the Order.
router.post("/:id/payment-proof", optionalClientOrStaff, transferLimiter, validate(submitPaymentProofSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { paymentRef, proofImage, phone } = req.validated.body;
  // A proof image alone is not a payment claim: the reviewer matches a real
  // reference against the bank statement, so never invent one.
  if (!paymentRef) {
    return res.status(400).json({ error: "A real transfer reference is required." });
  }
  if (!proofImage) {
    return res.status(400).json({ error: "A payment screenshot is required." });
  }
  try {
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!PROOF_PAYMENT_METHODS.has(order.paymentMethod)) {
      return res.status(400).json({ error: "Only Fawry or InstaPay orders accept payment proof submissions." });
    }
    req.validated = {
      params: { id },
      body: {
        senderName: order.customerName,
        transferReference: paymentRef,
        // The deprecated shim has no date field; use the actual submission
        // time rather than inventing a transfer reference or timestamp claim.
        transferredAt: new Date().toISOString(),
        evidenceBase64: proofImage,
        phone,
      },
    };
    return transferSubmissionHandler(req, res);
  } catch (e) {
    return res.status(e?.status ?? 500).json({ error: e?.message ?? "Failed to submit transfer details" });
  }
});

router.patch("/:id/payment", authenticateUser, requireStaff, validate(updateOrderPaymentSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { paymentStatus, paymentMethod } = req.validated.body;
  try {
    // Defense in depth: the schema accepts "paid" only so this route can give
    // clients an actionable error instead of a generic validation failure.
    if (paymentStatus === "paid") {
      return res.status(400).json({
        error: "Use cash confirmation or transfer verification to mark an order paid.",
      });
    }
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Order not found" });

    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.order.update({
        where: { id },
        data: {
          paymentStatus,
          ...(paymentMethod ? { paymentMethod } : {}),
          paidAt: null,
        },
      });
      await syncOrderPaymentStatus(tx, order, paymentStatus, { method: order.paymentMethod });
      return order;
    }, { timeout: 15000 });
    logAudit("order_payment", id, `Order ${updated.customerName} marked ${paymentStatus} (${updated.paymentMethod})`);

    // Only rejection-style edits notify the customer; any "success" mail must
    // come from a verification event, never from a generic status patch.
    if (existing.email && paymentStatus === "rejected") {
      const { sendMail, buildPaymentFailedEmail } = await import("../lib/email.js");
      const clinicSettings = await prisma.clinicSettings.findUnique({ where: { id: 1 } }).catch(() => null);
      const clinicName = clinicSettings?.name || "Paw-M Clinic";
      sendMail(buildPaymentFailedEmail({
        to: existing.email, customerName: updated.customerName, orderId: updated.id,
        method: updated.paymentMethod, clinicName,
        reason: "Payment proof was not accepted or payment could not be verified.",
      })).catch(() => {});
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
    // Cancellation is always allowed; completion is a financial state change.
    if (status === "completed" && existing.paymentStatus !== "paid") {
      return res.status(400).json({ error: "Payment must be verified before completing an order." });
    }

    const updated = await prisma.$transaction(
      async (tx) => {
        if (typeof tx.$queryRaw === "function") {
          await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`;
        }
        const fresh = await tx.order.findUnique({ where: { id } });
        if (!fresh) throw Object.assign(new Error("Order not found"), { status: 404 });
        // Re-check under the row lock: a concurrent edit cannot flip payment
        // status between the early validation and this write.
        if (status === "completed" && fresh.paymentStatus !== "paid") {
          throw Object.assign(new Error("Payment must be verified before completing an order."), { status: 400 });
        }
        if (status === "cancelled" && fresh.status !== "cancelled") {
          await restoreStockOnCancel(tx, fresh.items);
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
    if (e?.status === 400 || e?.status === 404 || e?.status === 409) {
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
