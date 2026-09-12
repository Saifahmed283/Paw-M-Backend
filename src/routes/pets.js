import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { isValidBase64Image, getBase64ByteLength, logAudit } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import {
  authenticateClient,
  authenticateClientOrStaff,
} from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createPetSchema, updatePetSchema } from "../schemas/pets.js";

const router = Router();
const log = logger.child({ module: "routes/pets" });

const MAX_PHOTO_BYTES = 2_500_000;

router.get("/", authenticateClientOrStaff, async (req, res) => {
  try {
    const where = req.client ? { clientId: req.client.id } : {};
    const pets = await prisma.pet.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: req.client
        ? undefined
        : { client: { select: { id: true, fullName: true, email: true, phone: true } } },
    });
    res.json(pets);
  } catch (e) {
    log.error({ err: e }, "failed to fetch pets");
    res.status(500).json({ error: "Failed to fetch pets" });
  }
});

router.post("/", authenticateClient, validate(createPetSchema), async (req, res) => {
  const b = req.validated.body;
  if (b.photo.length > 0) {
    if (!isValidBase64Image(b.photo) || getBase64ByteLength(b.photo) > MAX_PHOTO_BYTES) {
      return res.status(400).json({ error: "Photo must be a valid image under 2.5 MB" });
    }
  }
  try {
    const pet = await prisma.pet.create({
      data: {
        clientId: req.client.id,
        name: b.name,
        species: b.species,
        breed: b.breed,
        sex: b.sex,
        dob: b.dob,
        weightKg: b.weightKg,
        color: b.color,
        microchip: b.microchip,
        photo: b.photo,
        notes: b.notes,
      },
    });
    res.status(201).json(pet);
  } catch (e) {
    log.error({ err: e }, "failed to create pet");
    res.status(500).json({ error: "Failed to create pet" });
  }
});

router.patch("/:id", authenticateClientOrStaff, validate(updatePetSchema), async (req, res) => {
  const { id } = req.validated.params;
  const b = req.validated.body;
  try {
    const existing = await prisma.pet.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Pet not found" });
    if (req.client && existing.clientId !== req.client.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (b.photo && b.photo.length > 0) {
      if (!isValidBase64Image(b.photo) || getBase64ByteLength(b.photo) > MAX_PHOTO_BYTES) {
        return res.status(400).json({ error: "Photo must be a valid image under 2.5 MB" });
      }
    }
    const updated = await prisma.pet.update({ where: { id }, data: b });
    res.json(updated);
  } catch (e) {
    log.error({ err: e }, "failed to update pet");
    res.status(404).json({ error: "Pet not found" });
  }
});

router.get("/:id/history", authenticateClientOrStaff, async (req, res) => {
  const { id } = req.params;
  try {
    const pet = await prisma.pet.findUnique({
      where: { id },
      include: { client: { select: { id: true, fullName: true, phone: true } } },
    });
    if (!pet) return res.status(404).json({ error: "Pet not found" });
    if (req.client && pet.clientId !== req.client.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const [bookings, prescriptions] = await Promise.all([
      prisma.booking.findMany({
        where: { petId: id },
        orderBy: { createdAt: "desc" },
      }),
      prisma.prescription.findMany({
        where: { petId: id },
        orderBy: { createdAt: "desc" },
        include: {
          doctor: { select: { id: true, name: true, title: true, specialization: true } },
          booking: { select: { id: true, date: true, time: true } },
        },
      }),
    ]);
    res.json({ pet, bookings, prescriptions });
  } catch (e) {
    log.error({ err: e }, "failed to fetch pet history");
    res.status(500).json({ error: "Failed to fetch pet history" });
  }
});

router.delete("/:id", authenticateClientOrStaff, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.pet.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Pet not found" });
    if (req.client && existing.clientId !== req.client.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await prisma.pet.delete({ where: { id } });
    logAudit("pet_delete", id, `Deleted pet ${existing.name}`);
    res.status(204).send();
  } catch (e) {
    log.error({ err: e }, "failed to delete pet");
    res.status(404).json({ error: "Pet not found" });
  }
});

export default router;