import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit, sanitizePetType } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireAdmin, requirePayrollOrAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createProductSchema,
  updateProductSchema,
  updateStockSchema,
} from "../schemas/products.js";
import { adjustStock } from "../services/stock.js";

const router = Router();
const log = logger.child({ module: "routes/products" });

// Product images are stored inline as base64 data URIs in a TEXT column. The 26
// seeded images total ~50 MB, so serialising them into every list response
// produced a ~52 MB JSON body that exhausted the response buffer (HTTP 500) and
// could OOM a small container. Lists therefore expose a stable URL and the bytes
// are streamed one product at a time by GET /:id/image.
const DATA_URI_RE = /^data:([\w.+-]+\/[\w.+-]+)?((?:;[\w-]+=[\w-]+)*);base64,([\s\S]*)$/;

function isDataUri(value) {
  return typeof value === "string" && DATA_URI_RE.test(value);
}

// Derive the public API origin from the request itself. The frontend computes its
// own API base from window.location rather than a fixed env var, so mirroring
// that here keeps generated image URLs correct on localhost, LAN and behind the
// DigitalOcean load balancer (app.set("trust proxy", 1) makes req.protocol right).
function requestOrigin(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function productImageUrl(req, id) {
  return `${requestOrigin(req)}/api/products/${encodeURIComponent(id)}/image`;
}

function serializeProduct(req, product) {
  if (!product) return product;
  return {
    ...product,
    image: isDataUri(product.image) ? productImageUrl(req, product.id) : product.image,
  };
}

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
    res.json(paginatedResponse(products.map((product) => serializeProduct(req, product)), total, p));
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

router.get("/:id/image", async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { image: true },
    });
    const stored = product?.image;
    if (!stored) return res.status(404).json({ error: "Image not found" });

    // A stored http(s) value is a plain remote URL; hand the browser off to it
    // rather than proxying the bytes through the API.
    if (/^https?:\/\//i.test(stored)) return res.redirect(302, stored);

    const match = DATA_URI_RE.exec(stored);
    if (!match) return res.status(404).json({ error: "Image not found" });

    const [, mime, , base64] = match;
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0) return res.status(404).json({ error: "Image not found" });

    res.setHeader("Content-Type", mime || "application/octet-stream");
    res.setHeader("Content-Length", buffer.length);
    // Product images are effectively immutable, so let the browser cache them
    // instead of re-downloading multi-megabyte payloads on every dashboard visit.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    return res.end(buffer);
  } catch (e) {
    log.error({ err: e }, "failed to serve product image");
    res.status(500).json({ error: "Failed to fetch image" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(serializeProduct(req, product));
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
    res.status(201).json(serializeProduct(req, created));
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
    res.json(serializeProduct(req, updated));
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
