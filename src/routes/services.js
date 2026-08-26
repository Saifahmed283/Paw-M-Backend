import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireAdmin } from "../middleware/auth.js";

const router = Router();
const log = logger.child({ module: "routes/services" });

router.get("/", async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const [services, total] = await Promise.all([
      prisma.service.findMany({ skip: p.skip, take: p.limit }),
      prisma.service.count(),
    ]);
    res.json(paginatedResponse(services, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to fetch services");
    res.status(500).json({ error: "Failed to fetch services" });
  }
});

router.post("/", authenticateUser, requireAdmin, async (req, res) => {
  const body = req.body ?? {};
  try {
    const created = await prisma.service.create({
      data: {
        slug: String(body.slug ?? `svc-${Date.now().toString(36)}`).slice(0, 80),
        icon: String(body.icon ?? "Stethoscope").slice(0, 40),
        title: String(body.title ?? "").slice(0, 120),
        description: String(body.description ?? "").slice(0, 2000),
      },
    });
    logAudit("service_create", created.slug, `Created service ${created.title}`);
    res.status(201).json(created);
  } catch (e) {
    log.error({ err: e }, "failed to create service");
    res.status(500).json({ error: "Failed to create service" });
  }
});

router.patch("/:slug", authenticateUser, requireAdmin, async (req, res) => {
  const { slug } = req.params;
  const patch = req.body ?? {};
  const data = {};
  if (patch.icon !== undefined) data.icon = String(patch.icon).slice(0, 40);
  if (patch.title !== undefined) data.title = String(patch.title).slice(0, 120);
  if (patch.description !== undefined) data.description = String(patch.description).slice(0, 2000);
  try {
    const updated = await prisma.service.update({ where: { slug }, data });
    logAudit("service_update", slug, `Updated service ${updated.title}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Service not found" });
  }
});

router.delete("/:slug", authenticateUser, requireAdmin, async (req, res) => {
  const { slug } = req.params;
  try {
    const existing = await prisma.service.findUnique({ where: { slug } });
    await prisma.service.delete({ where: { slug } });
    logAudit("service_delete", slug, `Deleted service ${existing?.title ?? "unknown"}`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Service not found" });
  }
});

export default router;
