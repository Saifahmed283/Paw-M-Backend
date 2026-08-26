import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireAdmin } from "../middleware/auth.js";

const router = Router();
const log = logger.child({ module: "routes/google" });

router.post("/sync-reviews", authenticateUser, requireAdmin, async (req, res) => {
  const { placeId } = req.body ?? {};
  try {
    const settings = await prisma.clinicSettings.findUnique({ where: { id: 1 } });
    const apiKey = settings?.googlePlacesKey ?? "";
    if (!apiKey) return res.status(400).json({ error: "Google Places API key not configured in settings." });
    const pid = placeId || settings?.googlePlacesId || "";
    if (!pid) return res.status(400).json({ error: "Google Places ID not configured in settings." });
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(pid)}&fields=reviews,rating,user_ratings_total&key=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== "OK" || !data.result?.reviews) {
      return res.status(400).json({ error: data.error_message || "Failed to fetch Google reviews." });
    }
    const reviews = data.result.reviews;
    let created = 0;
    for (const gReview of reviews) {
      const exists = await prisma.review.findFirst({
        where: { OR: [{ id: `google-${gReview.time}` }, { author: gReview.author_name, comment: gReview.text }] },
      });
      if (exists) continue;
      await prisma.review.create({
        data: {
          productId: "clinic", author: gReview.author_name, rating: gReview.rating,
          comment: gReview.text, status: "approved", id: `google-${gReview.time}`,
        },
      });
      created++;
    }
    res.json({ synced: created, total: reviews.length });
  } catch (e) {
    log.error({ err: e }, "google sync failed");
    res.status(500).json({ error: "Failed to sync Google reviews." });
  }
});

export default router;
