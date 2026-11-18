import { Router } from "express";
import { Prisma } from "@prisma/client";
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
// seeded images total ~50 MB, so selecting the column pulled the whole payload
// across the connection: a full-row list query took ~18 s and was cancelled by the
// 15 s statement timeout (Postgres 57014), which surfaced as HTTP 500 and, on a
// memory-constrained container, as an OOM restart loop. Image bytes are therefore
// never part of a list or detail query; they are streamed one product at a time by
// GET /:id/image.
const DATA_URI_RE = /^data:([\w.+-]+\/[\w.+-]+)?((?:;[\w-]+=[\w-]+)*);base64,([\s\S]*)$/;

// Every Product column except `image`.
const PRODUCT_COLUMNS = {
  id: true,
  name: true,
  description: true,
  price: true,
  compareAtPrice: true,
  category: true,
  petType: true,
  stock: true,
  minStockAlert: true,
  featured: true,
  barcode: true,
  barcodeImage: true,
  createdAt: true,
  updatedAt: true,
};

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

// Classify each product's stored image from its TOAST prefix, which Postgres can
// evaluate without transferring the payload. Inline data URIs become a stable
// endpoint URL; remote http(s) URLs stay as-is because they are already cheap to
// inline; anything else is reported as having no image.
async function loadImageRefs(id) {
  const classify = (rows) =>
    rows.map((row) => [row.id, row.kind === "data" ? "data" : row.kind === "remote" ? "remote" : ""]);

  const [kinds, remotes] = await Promise.all([
    id
      ? prisma.$queryRaw(Prisma.sql`
          SELECT "id",
                 CASE
                   WHEN left("image", 5) = 'data:' THEN 'data'
                   WHEN left("image", 4) = 'http' THEN 'remote'
                   ELSE ''
                 END AS "kind"
          FROM "Product" WHERE "id" = ${id}`)
      : prisma.$queryRaw`
          SELECT "id",
                 CASE
                   WHEN left("image", 5) = 'data:' THEN 'data'
                   WHEN left("image", 4) = 'http' THEN 'remote'
                   ELSE ''
                 END AS "kind"
          FROM "Product"`,
    id
      ? prisma.$queryRaw(Prisma.sql`
          SELECT "id", "image" FROM "Product" WHERE left("image", 4) = 'http' AND "id" = ${id}`)
      : prisma.$queryRaw`SELECT "id", "image" FROM "Product" WHERE left("image", 4) = 'http'`,
  ]);

  const remoteById = new Map(remotes.map((row) => [row.id, row.image]));
  return {
    dataIds: new Set(classify(kinds).filter(([, kind]) => kind === "data").map(([pid]) => pid)),
    remoteById,
  };
}

function withImage(req, product, refs) {
  let image = "";
  if (refs.dataIds.has(product.id)) image = productImageUrl(req, product.id);
  else if (refs.remoteById.has(product.id)) image = refs.remoteById.get(product.id);
  return { ...product, image };
}

// Used for create/update responses, where the single record already carries its
// own image column.
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
    const [products, total, imageRefs] = await Promise.all([
      prisma.product.findMany({
        select: PRODUCT_COLUMNS,
        orderBy: { createdAt: "desc" },
        skip: p.skip,
        take: p.limit,
      }),
      prisma.product.count(),
      loadImageRefs(),
    ]);
    const data = products.map((product) => withImage(req, product, imageRefs));
    res.json(paginatedResponse(data, total, p));
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

    // Handle client disconnect gracefully to avoid "Error: aborted" noise
    const onClose = () => {
      // Client disconnected before we could finish sending - this is normal
      // and not an error condition, so we don't log it.
    };
    res.on("close", onClose);

    return res.end(buffer, () => {
      res.off("close", onClose);
    });
  } catch (e) {
    log.error({ err: e }, "failed to serve product image");
    // Only send error response if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to fetch image" });
    }
  }
});

router.get("/:id", async (req, res) => {
  try {
    const [product, imageRefs] = await Promise.all([
      prisma.product.findUnique({ where: { id: req.params.id }, select: PRODUCT_COLUMNS }),
      loadImageRefs(req.params.id),
    ]);
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(withImage(req, product, imageRefs));
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
