import { prisma } from "../lib/prisma.js";
import { nextId } from "../lib/utils.js";

const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * The single normalized finance row for a sale. Every order creates exactly one
 * `kind: "order"` payment, but older data may contain duplicates — always pick
 * the oldest so status syncs are deterministic.
 */
export async function canonicalOrderPayment(db, orderId) {
  if (!orderId) return null;
  const rows = await db.payment.findMany({
    where: { orderId, kind: "order" },
    orderBy: { createdAt: "asc" },
    take: 2,
  });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/** Order is the source of truth for the sale; the Payment row mirrors it. */
export async function syncOrderPaymentStatus(db, order, status, options = {}) {
  if (!order?.id) return null;
  const linked = await canonicalOrderPayment(db, order.id);
  const data = { status };
  if (options.method) data.method = options.method;

  if (linked) {
    return db.payment.update({ where: { id: linked.id }, data });
  }

  // Legacy orders were created before sale payments existed — create one now
  // so Finance collects from a single source of truth.
  return db.payment.create({
    data: {
      id: await nextId("PAY", "payment"),
      title: `Order — ${order.customerName ?? "customer"}`.slice(0, 200),
      amount: Number(order.total ?? 0),
      method: options.method ?? order.paymentMethod ?? "cash",
      status,
      date: localDate(),
      notes: "Order payment",
      orderId: order.id,
      kind: "order",
      ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
    },
  });
}

/** Payment is edited directly in Finance; the Order mirrors it. */
export async function syncPaymentToOrder(db, payment) {
  if (!payment?.orderId || payment.kind !== "order") return null;
  // Hard stop: no Finance edit may settle an order. Only confirm-cash, POS cash
  // reception and admin transfer approval may write paymentStatus:"paid".
  if (payment.status === "paid") {
    throw Object.assign(new Error("Order payments are settled through verification only."), { status: 400 });
  }
  const order = await db.order.findUnique({ where: { id: payment.orderId } });
  if (!order) return null;
  const methodChanged = Boolean(payment.method) && order.paymentMethod !== payment.method;
  if (
    !methodChanged &&
    order.paymentStatus === payment.status &&
    (payment.status !== "paid" || order.paidAt)
  ) {
    return order;
  }

  const data = {
    paymentStatus: payment.status,
    ...(methodChanged ? { paymentMethod: payment.method } : {}),
    paidAt: payment.status === "paid" ? (order.paidAt ?? new Date()) : null,
  };
  return db.order.update({ where: { id: payment.orderId }, data });
}
