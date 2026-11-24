import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit, todayStr } from "../lib/utils.js";
import { clinicDayRange, expectedForDate, round2 } from "../lib/clinic-day.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireAdmin, requireStaff } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  approveTransferSchema,
  cashDrawerCloseSchema,
  rejectTransferSchema,
} from "../schemas/orders.js";
import { deleteEvidence, presignEvidence, storeEvidence } from "../services/evidence-store.js";
import { canonicalOrderPayment, syncOrderPaymentStatus } from "../services/payment-status.js";

const router = Router();
const log = logger.child({ module: "routes/payment-verification" });

const DECISIONS = ["submitted", "under_review", "approved", "rejected", "superseded"];

// Both outlet (Fawry) and bank-transfer (InstaPay) orders settle by submitting
// payment evidence, which staff review against their records. Cash never does.
const PROOF_PAYMENT_METHODS = new Set(["fawry", "instapay"]);

// Client sessions are opaque tokens; staff JWTs contain dots. Returning 403 for
// a recognized client token keeps the admin API contract explicit (a missing
// token still yields 401 from authenticateUser).
function denyClientSession(req, res, next) {
  const auth = String(req.headers.authorization ?? "");
  if (auth.startsWith("Bearer ") && !auth.slice(7).includes(".")) {
    return res.status(403).json({ error: "Forbidden — staff access only" });
  }
  return next();
}

const fail = (status, message) => Object.assign(new Error(message), { status });

function respondWithError(res, err, fallbackMessage) {
  if (err?.code === "P2002") {
    return res.status(409).json({ error: "Bank transaction reference is already used." });
  }
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600) {
    return res.status(err.status).json({ error: err.message });
  }
  log.error({ err }, fallbackMessage);
  return res.status(500).json({ error: fallbackMessage });
}

/** Serialize concurrent reviewers on the same row with Postgres row locks. */
async function lockVerification(tx, id) {
  if (typeof tx.$queryRaw === "function") {
    await tx.$queryRaw`SELECT "id" FROM "PaymentVerification" WHERE "id" = ${id} FOR UPDATE`;
  }
}

async function lockOrder(tx, id) {
  if (typeof tx.$queryRaw === "function") {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`;
  }
}

/** Guests prove ownership with the exact order phone; signed-in clients own the order. */
function assertOwnership(req, order, phone) {
  if (req.user) return; // staff token / session
  if (req.client) {
    if (order.clientId !== req.client.id) {
      throw fail(403, "You can only submit proof for your own order.");
    }
    return;
  }
  if (!phone || String(phone).trim() !== order.phone) {
    throw fail(403, "Phone number does not match this order.");
  }
}

function assertSubmittable(order, isStaff) {
  if (order.status === "cancelled") throw fail(400, "This order is cancelled.");
  if (order.paymentStatus === "paid") throw fail(409, "This order is already paid.");
  if (["proof_submitted", "under_review"].includes(order.paymentStatus) && !isStaff) {
    throw fail(409, "Payment details are already under review.");
  }
}

async function sendPaymentEmail(order, outcome, reason = "") {
  if (!order?.email) return;
  try {
    const { sendMail, buildPaymentSuccessEmail, buildPaymentFailedEmail } = await import("../lib/email.js");
    const clinicSettings = await prisma.clinicSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    const clinicName = clinicSettings?.name || "Paw-M Clinic";
    const mail = outcome === "success"
      ? buildPaymentSuccessEmail({
          to: order.email, customerName: order.customerName, orderId: order.id,
          amount: order.total, method: order.paymentMethod, clinicName,
        })
      : buildPaymentFailedEmail({
          to: order.email, customerName: order.customerName, orderId: order.id,
          method: order.paymentMethod, clinicName, reason,
        });
    await sendMail(mail);
  } catch (err) {
    log.warn({ err }, "payment notification could not be sent");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Order-scoped handlers (mounted on /api/orders by routes/orders.js)
// ─────────────────────────────────────────────────────────────────────────────

/** Staff-only financial event: cash counted at the counter. */
export async function confirmCashHandler(req, res) {
  const { id } = req.validated.params;
  const { amountReceived, note } = req.validated.body;
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) throw fail(404, "Order not found");
    if (existing.status === "cancelled") throw fail(400, "A cancelled order cannot receive cash.");
    if (existing.paymentStatus === "paid") throw fail(409, "This order is already paid.");
    if (existing.paymentMethod !== "cash") throw fail(400, "Only cash orders can be confirmed with cash.");
    if (Math.abs(round2(amountReceived) - round2(existing.total)) > 0.01) {
      throw fail(400, "Amount received must match the order total.");
    }

    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await lockOrder(tx, id);
      const fresh = await tx.order.findUnique({ where: { id } });
      if (!fresh) throw fail(404, "Order not found");
      if (fresh.paymentStatus === "paid") throw fail(409, "This order is already paid.");
      if (fresh.status === "cancelled") throw fail(400, "A cancelled order cannot receive cash.");

      const verification = await tx.paymentVerification.create({
        data: {
          orderId: id,
          paymentId: (await canonicalOrderPayment(tx, id))?.id ?? null,
          method: "cash",
          amount: round2(existing.total),
          source: "cash_reception",
          decision: "approved",
          reviewerId: req.user.id,
          reviewedAt: now,
          note,
          createdAt: now,
        },
      });
      const order = await tx.order.update({
        where: { id },
        data: {
          paymentStatus: "paid",
          paidAt: now,
        },
      });
      await syncOrderPaymentStatus(tx, order, "paid", { method: "cash" });
      return { order, verification };
    }, { timeout: 15000 });

    logAudit("cash_received", id, `Cash EGP ${result.order.total} received by staff #${req.user.id}${note ? ` — ${note}` : ""}`);
    await sendPaymentEmail(result.order, "success");
    res.json(result.order);
  } catch (err) {
    respondWithError(res, err, "Failed to confirm cash payment");
  }
}

/** Guest-capable proof submission for Fawry or InstaPay; evidence goes to private storage. */
export async function transferSubmissionHandler(req, res) {
  const { id } = req.validated.params;
  const body = req.validated.body;
  let evidenceKey = "";
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) throw fail(404, "Order not found");
    if (!PROOF_PAYMENT_METHODS.has(existing.paymentMethod)) {
      throw fail(400, "Only Fawry or InstaPay orders accept payment proof submissions.");
    }
    assertSubmittable(existing, Boolean(req.user));
    assertOwnership(req, existing, body.phone);
    if (!body.transferredAt || Number.isNaN(new Date(body.transferredAt).getTime())) {
      throw fail(400, "A valid transfer date is required.");
    }
    if (!body.evidenceBase64) throw fail(400, "A payment screenshot is required.");

    evidenceKey = await storeEvidence(body.evidenceBase64, { orderId: id, kind: "transfer" });

    const verification = await prisma.$transaction(async (tx) => {
      await lockOrder(tx, id);
      const fresh = await tx.order.findUnique({ where: { id } });
      if (!fresh) throw fail(404, "Order not found");
      assertSubmittable(fresh, Boolean(req.user));

      await tx.paymentVerification.updateMany({
        where: { orderId: id, decision: { in: ["submitted", "under_review"] } },
        data: { decision: "superseded" },
      });
      const linked = await canonicalOrderPayment(tx, id);
      const row = await tx.paymentVerification.create({
        data: {
          orderId: id,
          paymentId: linked?.id ?? null,
          method: fresh.paymentMethod,
          amount: round2(fresh.total),
          source: "customer_transfer",
          customerRef: body.transferReference,
          senderName: body.senderName,
          transferredAt: body.transferredAt ? new Date(body.transferredAt) : null,
          evidenceKey,
          note: body.note,
          decision: "submitted",
        },
      });
      const order = await tx.order.update({
        where: { id },
        data: { paymentStatus: "proof_submitted", paymentRef: body.transferReference, proofImage: "" },
      });
      await syncOrderPaymentStatus(tx, order, "proof_submitted");
      return row;
    }, { timeout: 15000 });

    logAudit("transfer_submitted", id, `${verification.method} proof ${body.transferReference} submitted by ${body.senderName}`);
    // Never leak the private object key (or the original base64) to callers.
    res.json({ id: verification.id, decision: verification.decision, createdAt: verification.createdAt });
  } catch (err) {
    if (evidenceKey) await deleteEvidence(evidenceKey).catch(() => {});
    respondWithError(res, err, "Failed to submit transfer details");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin review API
// ─────────────────────────────────────────────────────────────────────────────

router.get("/admin/submissions", denyClientSession, authenticateUser, requireAdmin, async (req, res) => {
  const status = String(req.query.status ?? "submitted");
  if (status !== "all" && !DECISIONS.includes(status)) {
    return res.status(400).json({ error: "Invalid status filter" });
  }
  // A cashier can jump here with a specific sale; filter server-side so the
  // focused order is visible regardless of the currently selected status.
  const orderId = String(req.query.orderId ?? "").trim();
  try {
    const where = {
      ...(status === "all" ? {} : { decision: status }),
      ...(orderId ? { orderId } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.paymentVerification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        include: {
          order: { select: { customerName: true, phone: true, total: true } },
          reviewer: { select: { username: true } },
        },
      }),
      prisma.paymentVerification.count({ where }),
    ]);
    const submissions = rows.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      paymentId: row.paymentId,
      customerName: row.order?.customerName ?? "",
      phone: row.order?.phone ?? "",
      total: row.order?.total ?? row.amount,
      method: row.method,
      amount: row.amount,
      source: row.source,
      customerRef: row.customerRef,
      senderName: row.senderName,
      transferredAt: row.transferredAt,
      evidenceKey: row.evidenceKey,
      note: row.note,
      decision: row.decision,
      bankTransactionReference: row.bankTransactionReference,
      reviewerId: row.reviewerId,
      reviewerUsername: row.reviewer?.username ?? null,
      reviewedAt: row.reviewedAt,
      createdAt: row.createdAt,
    }));
    res.json({ submissions, total });
  } catch (err) {
    respondWithError(res, err, "Failed to load transfer submissions");
  }
});

router.post("/admin/:verificationId/approve", denyClientSession, authenticateUser, requireAdmin, validate(approveTransferSchema), async (req, res) => {
  const { verificationId } = req.validated.params;
  const { bankTransactionReference, note } = req.validated.body;
  try {
    const result = await prisma.$transaction(async (tx) => {
      await lockVerification(tx, verificationId);
      const existing = await tx.paymentVerification.findUnique({
        where: { id: verificationId },
        include: { order: true },
      });
      if (!existing) throw fail(404, "Verification not found");
      if (!["submitted", "under_review"].includes(existing.decision)) {
        throw fail(409, "This verification has already been decided.");
      }
      await lockOrder(tx, existing.orderId);
      const order = await tx.order.findUnique({ where: { id: existing.orderId } });
      if (!order) throw fail(404, "Order not found");
      if (order.status === "cancelled") throw fail(400, "A cancelled order cannot be marked paid.");
      if (order.paymentStatus === "paid") throw fail(409, "This order is already paid.");

      const duplicate = await tx.paymentVerification.findFirst({
        where: { bankTransactionReference, id: { not: verificationId } },
        select: { id: true },
      });
      if (duplicate) throw fail(409, "Bank transaction reference is already used.");

      const now = new Date();
      await tx.paymentVerification.updateMany({
        where: { orderId: existing.orderId, decision: { in: ["submitted", "under_review"] }, id: { not: verificationId } },
        data: { decision: "superseded" },
      });
      const verification = await tx.paymentVerification.update({
        where: { id: verificationId },
        data: {
          decision: "approved",
          bankTransactionReference,
          reviewerId: req.user.id,
          reviewedAt: now,
          ...(note ? { note } : {}),
        },
      });
      const updatedOrder = await tx.order.update({
        where: { id: existing.orderId },
        data: {
          paymentStatus: "paid",
          paidAt: now,
          paymentRef: bankTransactionReference,
        },
      });
      await syncOrderPaymentStatus(tx, updatedOrder, "paid", {
        method: updatedOrder.paymentMethod,
      });
      return { verification, order: updatedOrder };
    }, { timeout: 15000 });

    logAudit(
      "transfer_approved",
      result.order.id,
      `Transfer ${bankTransactionReference} approved for ${result.order.customerName} by staff #${req.user.id}`
    );
    await sendPaymentEmail(result.order, "success");
    res.json(result);
  } catch (err) {
    respondWithError(res, err, "Failed to approve transfer");
  }
});

router.post("/admin/:verificationId/reject", denyClientSession, authenticateUser, requireAdmin, validate(rejectTransferSchema), async (req, res) => {
  const { verificationId } = req.validated.params;
  const { reason } = req.validated.body;
  try {
    const verification = await prisma.$transaction(async (tx) => {
      await lockVerification(tx, verificationId);
      const existing = await tx.paymentVerification.findUnique({ where: { id: verificationId } });
      if (!existing) throw fail(404, "Verification not found");
      if (!["submitted", "under_review"].includes(existing.decision)) {
        throw fail(409, "This verification has already been decided.");
      }
      await lockOrder(tx, existing.orderId);
      const now = new Date();
      const row = await tx.paymentVerification.update({
        where: { id: verificationId },
        data: { decision: "rejected", reviewerId: req.user.id, reviewedAt: now, note: reason },
      });
      const order = await tx.order.update({
        where: { id: existing.orderId },
        data: { paymentStatus: "unpaid", paidAt: null },
      });
      await syncOrderPaymentStatus(tx, order, "unpaid");
      return row;
    }, { timeout: 15000 });

    logAudit("transfer_rejected", verification.orderId, `Transfer rejected by staff #${req.user.id}: ${reason}`);
    const order = await prisma.order.findUnique({ where: { id: verification.orderId } });
    await sendPaymentEmail(order, "failure", reason);
    res.json(verification);
  } catch (err) {
    respondWithError(res, err, "Failed to reject transfer");
  }
});

router.get("/admin/:verificationId/evidence-url", denyClientSession, authenticateUser, requireAdmin, async (req, res) => {
  try {
    const verification = await prisma.paymentVerification.findUnique({
      where: { id: req.params.verificationId },
      select: { evidenceKey: true },
    });
    if (!verification) return res.status(404).json({ error: "Verification not found" });
    if (!verification.evidenceKey) return res.status(404).json({ error: "No evidence attached to this submission" });
    const link = await presignEvidence(verification.evidenceKey, 300);
    res.json(link);
  } catch (err) {
    respondWithError(res, err, "Failed to issue evidence link");
  }
});

// ── Cairo-day cash drawer reconciliation ──────────────────────────────────────

router.post("/admin/cash-drawer/close", denyClientSession, authenticateUser, requireStaff, validate(cashDrawerCloseSchema), async (req, res) => {
  const { countedAmount, note } = req.validated.body;
  try {
    // Honour the day selected on the card. Falling back to "now" here made a
    // correction for an earlier day appear unsaved when the page reloaded.
    const date = req.validated.body.date ?? todayStr();
    const expected = await expectedForDate(prisma, date);
    const counted = round2(countedAmount);
    const variance = round2(counted - expected);
    const data = { date, expected, counted, variance, countedBy: req.user.id, note };

    // One reconciliation per clinic day. Updating the existing row keeps a
    // corrected count visible immediately instead of stacking stale closes.
    const existing = await prisma.cashDrawerClose.findFirst({
      where: { date },
      orderBy: { createdAt: "desc" },
    });
    const record = existing
      ? await prisma.cashDrawerClose.update({ where: { id: existing.id }, data })
      : await prisma.cashDrawerClose.create({ data });

    logAudit(
      existing ? "cash_drawer_updated" : "cash_drawer_closed",
      date,
      `Drawer ${existing ? "updated" : "closed"}: expected ${expected}, counted ${counted}, variance ${variance} by staff #${req.user.id}`,
    );
    res.status(existing ? 200 : 201).json(record);
  } catch (err) {
    respondWithError(res, err, "Failed to close cash drawer");
  }
});

router.get("/admin/cash-drawer", denyClientSession, authenticateUser, requireStaff, async (req, res) => {
  const date = String(req.query.date ?? todayStr());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }
  try {
    const { start, end } = clinicDayRange(date);
    const liveExpected = await expectedForDate(prisma, date);
    const [close, payments] = await Promise.all([
      prisma.cashDrawerClose.findFirst({ where: { date }, orderBy: { createdAt: "desc" } }),
      prisma.paymentVerification.findMany({
        where: {
          decision: "approved",
          source: "cash_reception",
          createdAt: { gte: start, lt: end },
        },
        orderBy: { createdAt: "asc" },
        include: { order: { select: { customerName: true, phone: true } } },
      }),
    ]);
    // Once a count is saved, freeze the expected total that was reconciled.
    // Otherwise late approvals make an already-saved drawer look wrong and it
    // only becomes stable after the day ends.
    const expected = close?.expected === null || close?.expected === undefined
      ? liveExpected
      : round2(close.expected);
    res.json({
      date,
      close: close ?? null,
      expected,
      payments: payments.map((p) => ({
        id: p.id,
        orderId: p.orderId,
        method: p.method,
        amount: p.amount,
        source: p.source,
        bankTransactionReference: p.bankTransactionReference,
        customerName: p.order?.customerName ?? "",
        createdAt: p.createdAt,
      })),
    });
  } catch (err) {
    respondWithError(res, err, "Failed to load cash drawer");
  }
});

export default router;
