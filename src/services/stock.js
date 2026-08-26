import { prisma } from "../lib/prisma.js";

export async function adjustStock(productId, qtyChange, note, username, type) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    throw Object.assign(new Error("Product not found"), { status: 404 });
  }

  const newQty = product.stock + qtyChange;
  if (newQty < 0) {
    throw Object.assign(new Error(`Insufficient stock. Current: ${product.stock}, change: ${qtyChange}`), { status: 409 });
  }

  const movementType = type || (qtyChange > 0 ? "restock" : "adjustment");

  const [movement, updatedProduct] = await prisma.$transaction([
    prisma.stockMovement.create({
      data: {
        productId,
        productName: product.name,
        type: movementType,
        qtyChange,
        qtyBefore: product.stock,
        qtyAfter: newQty,
        note: note || "",
        changedBy: username,
      },
    }),
    prisma.product.update({
      where: { id: productId },
      data: { stock: newQty, updatedAt: new Date() },
    }),
  ]);

  return { product: updatedProduct, movement };
}
