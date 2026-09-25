import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit, sanitizePetType } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireAdmin, requirePayrollOrAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createProductSchema,
  importProductsSchema,
  updateProductSchema,
  updateStockSchema,
} from "../schemas/products.js";
import { adjustStock } from "../services/stock.js";

const router = Router();
const log = logger.child({ module: "routes/products" });

function normalizeProductText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function productImportKey(product) {
  const barcode = normalizeProductText(product.barcode);
  if (barcode) return `barcode:${barcode}`;
  return [
    "details",
    normalizeProductText(product.name),
    normalizeProductText(product.category),
    normalizeProductText(product.petType ?? "both"),
  ].join("|");
}

function importedProductCreateData(body) {
  return {
    name: body.name.trim(),
    description: body.description.trim(),
    price: body.price,
    compareAtPrice: body.compareAtPrice ?? null,
    image: body.image ?? "",
    category: body.category.trim(),
    petType: sanitizePetType(body.petType),
    stock: body.stock,
    featured: body.featured ?? false,
    barcode: body.barcode?.trim() || null,
    barcodeImage: body.barcodeImage || null,
  };
}

function importedProductUpdateData(body) {
  const data = {};
  if (body.name !== undefined) data.name = body.name.trim();
  if (body.description !== undefined) data.description = body.description.trim();
  if (body.price !== undefined) data.price = body.price;
  if (body.compareAtPrice !== undefined) data.compareAtPrice = body.compareAtPrice;
  if (body.image !== undefined) data.image = body.image;
  if (body.category !== undefined) data.category = body.category.trim();
  if (body.petType !== undefined) data.petType = sanitizePetType(body.petType);
  if (body.stock !== undefined) data.stock = body.stock;
  if (body.featured !== undefined) data.featured = body.featured;
  if (body.barcode !== undefined) data.barcode = body.barcode?.trim() || null;
  if (body.barcodeImage !== undefined) data.barcodeImage = body.barcodeImage || null;
  return data;
}

router.post(
  "/import",
  authenticateUser,
  requireAdmin,
  validate(importProductsSchema),
  async (req, res) => {
    const { products, duplicateAction, resolutions } = req.validated.body;
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const existingProducts = await tx.product.findMany();
          const productsByKey = new Map(
            existingProducts.map((product) => [productImportKey(product), product]),
          );
          const summary = { created: 0, updated: 0, skipped: 0 };
          const results = [];

          for (const [index, product] of products.entries()) {
            const key = productImportKey(product);
            const existing = productsByKey.get(key);
            const resolution = resolutions?.[index] ?? duplicateAction;
            if (existing && resolution === "skip") {
              summary.skipped += 1;
              results.push({ index, action: "skipped" });
              continue;
            }

            const saved = existing
              ? await tx.product.update({
                  where: { id: existing.id },
                  data: importedProductUpdateData(product),
                })
              : await tx.product.create({ data: importedProductCreateData(product) });
            productsByKey.delete(key);
            productsByKey.set(productImportKey(saved), saved);
            if (existing) {
              summary.updated += 1;
              results.push({ index, action: "updated" });
            } else {
              summary.created += 1;
              results.push({ index, action: "created" });
            }
          }

          const detail = `Imported products: ${summary.created} added, ${summary.updated} replaced, ${summary.skipped} skipped`;
          await tx.auditLog.create({
            data: {
              action: "product_import",
              target: resolutions ? "per-row" : duplicateAction,
              detail,
            },
          });

          return { summary, results, detail };
        },
        { maxWait: 5000, timeout: 30000 },
      );
      res.json(result);
    } catch (e) {
      log.error({ err: e }, "failed to import products");
      if (e?.code === "P2002") {
        return res.status(409).json({ error: "A product with this barcode already exists" });
      }
      res.status(500).json({ error: "Failed to import products" });
    }
  },
);

router.get("/low-stock", authenticateUser, requirePayrollOrAdmin, async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const allProducts = await prisma.product.findMany({
      select: { id: true, name: true, stock: true, minStockAlert: true },
    });
    const lowStockProducts = allProducts.filter((p) => p.stock <= p.minStockAlert);
    const total = lowStockProducts.length;
    const paginated = lowStockProducts.slice(p.skip, p.skip + p.limit);
    res.json(paginatedResponse(paginated, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to fetch low stock products");
    res.status(500).json({ error: "Failed to fetch low stock products" });
  }
});

router.get("/", async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const [products, total] = await Promise.all([
      prisma.product.findMany({ orderBy: { createdAt: "desc" }, skip: p.skip, take: p.limit }),
      prisma.product.count(),
    ]);
    res.json(paginatedResponse(products, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to fetch products");
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

router.get("/:id/stock-history", authenticateUser, requirePayrollOrAdmin, async (req, res) => {
  try {
    const productId = req.params.id;
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, name: true } });
    if (!product) return res.status(404).json({ error: "Product not found" });
    const p = parsePagination(req.query);
    const [movements, total] = await Promise.all([
      prisma.stockMovement.findMany({ where: { productId }, orderBy: { createdAt: "desc" }, skip: p.skip, take: p.limit }),
      prisma.stockMovement.count({ where: { productId } }),
    ]);
    res.json(paginatedResponse(movements, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to fetch stock history");
    res.status(500).json({ error: "Failed to fetch stock history" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch {
    res.status(404).json({ error: "Product not found" });
  }
});

router.post("/", authenticateUser, requireAdmin, validate(createProductSchema), async (req, res) => {
  const body = req.validated.body;
  try {
    const created = await prisma.product.create({
      data: {
        name: body.name,
        description: body.description,
        price: body.price,
        compareAtPrice: body.compareAtPrice ?? null,
        image: body.image,
        category: body.category,
        petType: sanitizePetType(body.petType),
        stock: body.stock,
        featured: body.featured,
        barcode: body.barcode?.trim() || null,
        barcodeImage: body.barcodeImage || null,
      },
    });
    logAudit("product_create", created.id, `Created product ${created.name}`);
    res.status(201).json(created);
  } catch (e) {
    log.error({ err: e }, "failed to create product");
    res.status(500).json({ error: "Failed to create product" });
  }
});

router.patch("/:id", authenticateUser, requireAdmin, validate(updateProductSchema), async (req, res) => {
  const { id } = req.validated.params;
  const patch = req.validated.body;
  const data = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.image !== undefined) data.image = patch.image;
  if (patch.category !== undefined) data.category = patch.category;
  if (patch.petType !== undefined) data.petType = sanitizePetType(patch.petType);
  if (patch.featured !== undefined) data.featured = patch.featured;
  if (patch.price !== undefined) data.price = patch.price;
  if (patch.compareAtPrice !== undefined) data.compareAtPrice = patch.compareAtPrice;
  if (patch.stock !== undefined) data.stock = patch.stock;
  if (patch.barcode !== undefined) data.barcode = patch.barcode?.trim() || null;
  if (patch.barcodeImage !== undefined) data.barcodeImage = patch.barcodeImage || null;
  try {
    const updated = await prisma.product.update({ where: { id }, data });
    logAudit("product_update", id, `Updated product ${updated.name}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Product not found" });
  }
});

router.delete("/:id", authenticateUser, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.product.findUnique({ where: { id } });
    await prisma.product.delete({ where: { id } });
    logAudit("product_delete", id, `Deleted product ${existing?.name ?? "unknown"}`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Product not found" });
  }
});

router.patch("/:id/stock", authenticateUser, requireAdmin, validate(updateStockSchema), async (req, res) => {
  try {
    const { id } = req.validated.params;
    const { qtyChange, note, type } = req.validated.body;
    const result = await adjustStock(id, qtyChange, note, req.user.username, type);
    res.json(result);
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    log.error({ err: e }, "failed to update stock");
    res.status(500).json({ error: "Failed to update stock" });
  }
});

export default router;
