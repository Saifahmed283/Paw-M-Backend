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
