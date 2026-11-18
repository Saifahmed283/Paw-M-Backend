import { prisma } from "../lib/prisma.js";
import { isValidBase64Image, getBase64ByteLength } from "../lib/utils.js";

export async function createOrderTransactional(tx, body, isPos = false) {
  const items = Array.isArray(body.items) ? body.items : [];
  const discountAmount = Number(body.discountAmount ?? 0);
  const discountLabel = String(body.discountLabel ?? "").slice(0, 120);
  let total = 0;
  const lines = [];

  for (const item of items) {
    const id = String(item?.id ?? "").slice(0, 60);
    const qty = Number(item?.qty ?? 0);
    if (!id || !Number.isInteger(qty) || qty <= 0) {
      throw Object.assign(new Error("Invalid cart line."), { status: 400 });
    }

    // Clinic services are not catalogue products: they hold no stock and the
    // cashier enters the price for each visit manually. Keep them out of the
    // product lookup/stock path (store checkouts never send service lines).
    if (id.startsWith("service-")) {
      if (!isPos) {
        throw Object.assign(new Error("Invalid cart line."), { status: 400 });
      }
      const candidate = Number(item?.price);
      if (!Number.isFinite(candidate) || candidate < 0) {
        throw Object.assign(new Error("Invalid service price."), { status: 400 });
      }
      const name =
        typeof item?.name === "string" && item.name.trim()
          ? item.name.trim().slice(0, 200)
          : id.slice(0, 200);
      const price = Math.round(candidate * 100) / 100;
      total += price * qty;
      lines.push({ id, name, price, qty, image: "" });
      continue;
    }

    const product = await tx.product.findUnique({ where: { id } });
    if (!product) {
      throw Object.assign(new Error(`Product ${id} no longer exists.`), { status: 400 });
    }
    if (product.stock < qty) {
      throw Object.assign(new Error(`${product.name} — only ${product.stock} left in stock.`), { status: 409 });
    }

    // POS orders may supply an override price (discounted) for the line's displayed
    // price and total. Always validate against the real product price so a discount
    // can never exceed the catalog price. Store checkout never sends a price override.
    const dbPrice = Number(product.price);
    let price = dbPrice;
    let name = product.name.slice(0, 200);
    if (isPos && item?.price !== undefined && item?.price !== null) {
      const candidate = Number(item.price);
      if (Number.isFinite(candidate) && candidate >= 0 && candidate <= dbPrice) {
        price = Math.round(candidate * 100) / 100;
      } else {
        throw Object.assign(new Error(`${product.name} — invalid line price.`), { status: 400 });
      }
      if (typeof item.name === "string" && item.name.trim()) {
        name = item.name.trim().slice(0, 200);
      }
    }

    const lineTotal = price * qty;
    total += lineTotal;
    lines.push({
      id,
      name,
      price,
      qty,
      image: product.image.slice(0, 500),
    });
    await tx.product.update({
      where: { id },
      data: { stock: { decrement: qty } },
    });
  }

  // Apply the order-level discount (POS only) after per-line overrides are summed.
  const cappedDiscount = isPos
    ? Math.min(Math.max(0, discountAmount), total)
    : 0;
  total = Math.round((total - cappedDiscount) * 100) / 100;

  return { total, lines, discountAmount: cappedDiscount, discountLabel };
}

export function validateProofImage(proofImage) {
  if (!proofImage || proofImage.length === 0) return { valid: true };
  if (!isValidBase64Image(proofImage)) {
    return { valid: false, error: "Invalid proof image format." };
  }
  const bytes = getBase64ByteLength(proofImage);
  if (bytes > 4 * 1024 * 1024) {
    return { valid: false, error: "Proof image is too large (max 4 MB)." };
  }
  return { valid: true };
}

export async function restoreStockOnCancel(tx, existingItems) {
  const lines = Array.isArray(existingItems) ? existingItems : [];
  for (const item of lines) {
    const itemId = String(item?.id ?? "").slice(0, 60);
    const itemQty = Number(item?.qty ?? 0);
    await tx.product.updateMany({
      where: { id: itemId },
      data: { stock: { increment: itemQty } },
    });
  }
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => Math.max(0, round2(n));

// Refund labels are stored as "<qty>x <name>" on PaymentItem rows. Recover the
// leading integer so prior refunds reduce the qty remaining for that line.
function refundedQtyFromLabel(label) {
  const match = /^\s*(\d+)\s*x(?:\s|$)/i.exec(String(label ?? ""));
  const qty = Number(match?.[1] ?? 0);
  return Number.isFinite(qty) ? qty : 0;
}

/**
 * Pure refund planner. Given an order, its existing refund payments and an
 * optional requested-line list, returns the amounts to write plus what will
 * remain afterwards. No database access so the math can be unit-tested.
 *
 * @throws {Error} with `status` 400 for invalid/over-refund requests, 409 when
 * the order has nothing left to refund.
 */
export function computeRefundPlan(order, payments = [], requestedItems) {
  const orderLines = Array.isArray(order?.items) ? order.items : [];
  const discount = Math.max(0, Number(order?.discountAmount ?? 0) || 0);

  // Aggregate by line id (JSON order items are normally unique, but this keeps
  // the totals correct if a duplicated id ever slips through).
  const lines = new Map();
  for (const item of orderLines) {
    const id = String(item?.id ?? "");
    if (!id) continue;
    const qty = Math.max(0, Number(item?.qty ?? 0) || 0);
    const gross = Math.max(0, Number(item?.price ?? 0) || 0) * qty;
    const existing = lines.get(id) ?? {
      id,
      name: String(item?.name ?? ""),
      kind: id.startsWith("service-") ? "service" : "product",
      qty: 0,
      gross: 0,
    };
    existing.qty += qty;
    existing.gross += gross;
    lines.set(id, existing);
  }

  const alreadyRefunded = new Map();
  for (const payment of Array.isArray(payments) ? payments : []) {
    if (payment?.kind !== "refund") continue;
    for (const item of Array.isArray(payment.items) ? payment.items : []) {
      const id = String(item?.referenceId ?? "");
      const qty = refundedQtyFromLabel(item?.label);
      if (!id || qty <= 0) continue;
      alreadyRefunded.set(id, (alreadyRefunded.get(id) ?? 0) + qty);
    }
  }

  const remainingLines = [...lines.values()].map((line) => {
    const price = line.qty > 0 ? line.gross / line.qty : 0;
    const refunded = alreadyRefunded.get(line.id) ?? 0;
    return { ...line, price, refunded, remaining: Math.max(0, line.qty - refunded) };
  });

  if (remainingLines.every((line) => line.remaining <= 0)) {
    throw Object.assign(new Error("Nothing left to refund on this order."), { status: 409 });
  }

  const requested = new Map();
  for (const item of Array.isArray(requestedItems) ? requestedItems : []) {
    const id = String(item?.id ?? "");
    const qty = Number(item?.qty ?? 0);
    if (!id || !Number.isInteger(qty) || qty <= 0) {
      throw Object.assign(new Error("Invalid refund item."), { status: 400 });
    }
    requested.set(id, (requested.get(id) ?? 0) + qty);
  }

  const toRefund = requested.size === 0
    ? remainingLines.filter((line) => line.remaining > 0).map((line) => ({ ...line, qty: line.remaining }))
    : [...requested.entries()].map(([id, qty]) => {
        const line = remainingLines.find((candidate) => candidate.id === id);
        if (!line) {
          throw Object.assign(new Error(`Line ${id} is not on this order.`), { status: 400 });
        }
        if (qty > line.remaining) {
          throw Object.assign(
            new Error(`Line ${id} — only ${line.remaining} left to refund.`),
            { status: 400 }
          );
        }
        return { ...line, qty };
      });

  const orderSubtotal = remainingLines.reduce((sum, line) => sum + line.gross, 0);
  // Discount is spread across the whole order; each refund gets its
  // proportional share. Cap it at the order subtotal to keep refunds non-negative
  // even if legacy data carries an oversized discount.
  const cappedDiscount = Math.min(discount, orderSubtotal);
  const discountShare = (subtotal) =>
    orderSubtotal > 0 ? (cappedDiscount * subtotal) / orderSubtotal : 0;

  const refundedSubtotal = toRefund.reduce((sum, line) => sum + line.price * line.qty, 0);
  const refundedAmount = money(refundedSubtotal - discountShare(refundedSubtotal));

  const refundedByLine = new Map(toRefund.map((line) => [line.id, line.qty]));
  const afterLines = remainingLines.map((line) =>
    Math.max(0, line.remaining - (refundedByLine.get(line.id) ?? 0))
  );
  const remainingSubtotal = remainingLines.reduce(
    (sum, line, index) => sum + line.price * afterLines[index],
    0
  );

  return {
    refundedLines: toRefund.map((line) => ({
      id: line.id,
      name: line.name,
      qty: line.qty,
      amount: money(line.price * line.qty),
      kind: line.kind,
    })),
    refundedAmount,
    remainingRefundable: money(remainingSubtotal - discountShare(remainingSubtotal)),
    fullyRefunded: afterLines.every((qty) => qty <= 0),
  };
}
