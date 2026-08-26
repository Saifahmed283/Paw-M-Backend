import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireAdmin } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createReviewSchema, updateReviewStatusSchema } from "../schemas/reviews.js";

const router = Router();
const log = logger.child({ module: "routes/reviews" });

router.get("/", async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const [reviews, total] = await Promise.all([
      prisma.review.findMany({ orderBy: [{ status: "asc" }, { createdAt: "desc" }], skip: p.skip, take: p.limit }),
      prisma.review.count(),
    ]);
    res.json(paginatedResponse(reviews, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to fetch reviews");
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

router.get("/products/:id", async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where: { productId: req.params.id, status: "approved" },
        orderBy: { createdAt: "desc" },
        skip: p.skip,
        take: p.limit,
      }),
      prisma.review.count({ where: { productId: req.params.id, status: "approved" } }),
    ]);
    res.json(paginatedResponse(reviews, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to fetch reviews");
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

router.post("/", validate(createReviewSchema), async (req, res) => {
  const { productId, author, rating, comment } = req.validated.body;
  try {
    const created = await prisma.review.create({
      data: { productId, author, rating, comment, status: "pending" },
    });
    res.status(201).json(created);
  } catch (e) {
    log.error({ err: e }, "failed to create review");
    res.status(500).json({ error: "Failed to create review" });
  }
});

router.patch("/:id", authenticateUser, requireAdmin, validate(updateReviewStatusSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { status } = req.validated.body;
  try {
    const updated = await prisma.review.update({ where: { id }, data: { status } });
    logAudit("review_status", id, `Review ${status}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Review not found" });
  }
});

router.delete("/:id", authenticateUser, requireAdmin, async (req, res) => {
  try {
    await prisma.review.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Review not found" });
  }
});

export default router;
