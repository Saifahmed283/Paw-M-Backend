import { prisma } from "../lib/prisma.js";
import { isValidBase64Image, getBase64ByteLength } from "../lib/utils.js";

export async function createOrderTransactional(tx, body) {
  const items = Array.isArray(body.items) ? body.items : [];
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
    const price = Number(product.price);
    total += price * qty;
    lines.push({
      id,
      name: product.name.slice(0, 200),
      price,
      qty,
      image: product.image.slice(0, 500),
    });
    await tx.product.update({
      where: { id },
      data: { stock: { decrement: qty } },
    });
  }

  return { total: Math.round(total * 100) / 100, lines };
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
