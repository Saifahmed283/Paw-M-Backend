import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireAdmin } from "../middleware/auth.js";

const router = Router();
const log = logger.child({ module: "routes/doctors" });

router.get("/", async (_req, res) => {
  try {
    const doctors = await prisma.doctor.findMany();
    res.json(doctors);
  } catch (e) {
    log.error({ err: e }, "failed to fetch doctors");
    res.status(500).json({ error: "Failed to fetch doctors" });
  }
});

router.post("/", authenticateUser, requireAdmin, async (req, res) => {
  const body = req.body ?? {};
  try {
    const name = String(body.name ?? "").slice(0, 120);
    const specialization = String(body.specialization ?? "").slice(0, 200);
    const rating = Number(body.rating ?? 4.8);
    if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
      return res.status(400).json({ error: "rating must be a number between 0 and 5" });
    }
    if (!name) return res.status(400).json({ error: "name is required" });
    const created = await prisma.doctor.create({
      data: {
        id: String(body.id ?? `dr-${Date.now().toString(36)}`).slice(0, 60),
        name,
        specialization,
        experience: String(body.experience ?? "").slice(0, 80),
        rating,
        days: Array.isArray(body.days) ? body.days.map((d) => String(d).slice(0, 10)) : [],
        bio: String(body.bio ?? "").slice(0, 2000),
        initials: String(body.initials ?? "").slice(0, 6),
        tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).slice(0, 40)) : [],
        pets: Array.isArray(body.pets) ? body.pets.map((p) => String(p).slice(0, 20)) : [],
      },
    });
    logAudit("doctor_create", created.id, `Created doctor ${created.name}`);
    res.status(201).json(created);
  } catch (e) {
    log.error({ err: e }, "failed to create doctor");
    res.status(500).json({ error: "Failed to create doctor" });
  }
});

router.patch("/:id", authenticateUser, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const patch = req.body ?? {};
  const data = {};
  if (patch.name !== undefined) data.name = String(patch.name).slice(0, 120);
  if (patch.specialization !== undefined) data.specialization = String(patch.specialization).slice(0, 200);
  if (patch.experience !== undefined) data.experience = String(patch.experience).slice(0, 80);
  if (patch.rating !== undefined) {
    const rating = Number(patch.rating);
    if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
      return res.status(400).json({ error: "rating must be a number between 0 and 5" });
    }
    data.rating = rating;
  }
  if (patch.days !== undefined) data.days = Array.isArray(patch.days) ? patch.days.map((d) => String(d).slice(0, 10)) : undefined;
  if (patch.bio !== undefined) data.bio = String(patch.bio).slice(0, 2000);
  if (patch.initials !== undefined) data.initials = String(patch.initials).slice(0, 6);
  if (patch.tags !== undefined) data.tags = Array.isArray(patch.tags) ? patch.tags.map((t) => String(t).slice(0, 40)) : undefined;
  if (patch.pets !== undefined) data.pets = Array.isArray(patch.pets) ? patch.pets.map((p) => String(p).slice(0, 20)) : undefined;
  try {
    const updated = await prisma.doctor.update({ where: { id }, data });
    logAudit("doctor_update", id, `Updated doctor ${updated.name}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Doctor not found" });
  }
});

router.delete("/:id", authenticateUser, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.doctor.findUnique({ where: { id } });
    await prisma.doctor.delete({ where: { id } });
    logAudit("doctor_delete", id, `Deleted doctor ${existing?.name ?? "unknown"}`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Doctor not found" });
  }
});

export default router;
