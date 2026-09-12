import { Router } from "express";
import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import {
  authenticateUser,
  requireStaff,
  authenticateClientOrStaff,
} from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createPrescriptionSchema, updatePrescriptionSchema } from "../schemas/prescriptions.js";

const router = Router();
const log = logger.child({ module: "routes/prescriptions" });

function shortCode(len = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[randomBytes(1)[0] % alphabet.length];
  }
  return out;
}

async function uniqueRxNumber() {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  for (let i = 0; i < 8; i++) {
    const rxNumber = `RX-${ymd}-${shortCode(4)}`;
    const exists = await prisma.prescription.findUnique({ where: { rxNumber } });
    if (!exists) return rxNumber;
  }
  return `RX-${ymd}-${Date.now().toString(36).toUpperCase()}`;
}

async function uniqueVerifyCode() {
  for (let i = 0; i < 8; i++) {
    const verifyCode = shortCode(8);
    const exists = await prisma.prescription.findUnique({ where: { verifyCode } });
    if (!exists) return verifyCode;
  }
  return `VRY-${Date.now().toString(36).toUpperCase()}`;
}

router.get("/", authenticateUser, requireStaff, async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const where = {};
    if (req.query.petId) where.petId = String(req.query.petId);
    if (req.query.status) where.status = String(req.query.status);
    const [prescriptions, total] = await Promise.all([
      prisma.prescription.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: p.skip,
        take: p.limit,
        include: {
          pet: { select: { id: true, name: true, species: true, breed: true } },
          client: { select: { id: true, fullName: true, email: true } },
          doctor: { select: { id: true, name: true, title: true } },
          booking: { select: { id: true, date: true, time: true } },
        },
      }),
      prisma.prescription.count({ where }),
    ]);
    res.json(paginatedResponse(prescriptions, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to fetch prescriptions");
    res.status(500).json({ error: "Failed to fetch prescriptions" });
  }
});

router.get("/verify", async (req, res) => {
  const code = String(req.query.code ?? "").trim().toUpperCase();
  try {
    if (!code) return res.status(400).json({ error: "code is required" });
    const rx = await prisma.prescription.findUnique({
      where: { verifyCode: code },
      include: {
        pet: { select: { id: true, name: true, species: true, breed: true } },
        client: { select: { id: true, fullName: true, phone: true } },
        doctor: { select: { id: true, name: true, title: true, licenseNumber: true } },
      },
    });
    if (!rx) {
      return res.status(200).json({ valid: false, message: "Prescription not found. The code may be incorrect." });
    }
    if (rx.status === "void") {
      return res.status(200).json({ valid: false, message: "This prescription was voided by the clinic.", rxNumber: rx.rxNumber });
    }
    res.status(200).json({
      valid: true,
      rxNumber: rx.rxNumber,
      issuedAt: rx.issuedAt,
      pet: rx.pet ?? { name: rx.petName, species: rx.petSpecies, breed: rx.petBreed },
      client: rx.client,
      doctor: rx.doctor,
      diagnosis: rx.diagnosis,
    });
  } catch (e) {
    log.error({ err: e }, "failed to verify prescription");
    res.status(500).json({ error: "Failed to verify prescription" });
  }
});

router.get("/:id", authenticateClientOrStaff, async (req, res) => {
  const { id } = req.params;
  try {
    const rx = await prisma.prescription.findUnique({
      where: { id },
      include: {
        pet: { select: { id: true, name: true, species: true, breed: true, dob: true, weightKg: true } },
        client: { select: { id: true, fullName: true, email: true, phone: true } },
        doctor: { select: { id: true, name: true, title: true, licenseNumber: true, signatureImage: true, experience: true } },
        booking: { select: { id: true, date: true, time: true, diagnosis: true, treatmentNotes: true } },
      },
    });
    if (!rx) return res.status(404).json({ error: "Prescription not found" });
    if (req.client && rx.clientId !== req.client.id) {
      return res.status(403).json({ error: "Forbidden" });
    }
    res.json(rx);
  } catch (e) {
    log.error({ err: e }, "failed to fetch prescription");
    res.status(500).json({ error: "Failed to fetch prescription" });
  }
});

router.post("/", authenticateUser, requireStaff, validate(createPrescriptionSchema), async (req, res) => {
  const b = req.validated.body;
  try {
    const [doctor, pet] = await Promise.all([
      prisma.doctor.findUnique({ where: { id: b.doctorId } }),
      b.petId
        ? prisma.pet.findUnique({
            where: { id: b.petId },
            select: { id: true, clientId: true, name: true, species: true, breed: true },
          })
        : Promise.resolve(null),
    ]);
    if (!doctor) return res.status(400).json({ error: "Doctor not found" });
    if (b.petId && !pet) return res.status(400).json({ error: "Pet not found" });
    if (!pet && !b.petName.trim()) {
      return res.status(400).json({ error: "Patient name is required" });
    }

    if (b.bookingId) {
      const booking = await prisma.booking.findUnique({
        where: { id: b.bookingId },
        select: { petId: true, doctorId: true },
      });
      if (!booking) return res.status(400).json({ error: "Booking not found" });
      if (b.petId && booking.petId && booking.petId !== b.petId) {
        return res.status(400).json({ error: "Booking does not belong to this pet" });
      }
      if (!b.petId && booking.petId) {
        const bookingPet = await prisma.pet.findUnique({
          where: { id: booking.petId },
          select: { id: true, clientId: true, name: true, species: true, breed: true },
        });
        if (bookingPet) {
          return res.status(400).json({ error: "Select the booking's linked pet as the patient" });
        }
      }
    }

    const issued = b.status !== "draft";
    const created = await prisma.prescription.create({
      data: {
        rxNumber: await uniqueRxNumber(),
        verifyCode: await uniqueVerifyCode(),
        petId: pet?.id ?? null,
        clientId: pet?.clientId ?? null,
        petName: pet?.name ?? b.petName.trim(),
        petSpecies: pet?.species ?? b.petSpecies.trim(),
        petBreed: pet?.breed ?? b.petBreed.trim(),
        doctorId: doctor.id,
        bookingId: b.bookingId || null,
        diagnosis: b.diagnosis,
        items: b.items,
        instructions: b.instructions,
        followUpDate: b.followUpDate,
        status: b.status,
        issuedAt: issued ? new Date() : null,
        signatureSnapshot: issued
          ? {
              name: doctor.name,
              title: doctor.title,
              licenseNumber: doctor.licenseNumber,
              signatureImage: doctor.signatureImage,
            }
          : null,
      },
      include: {
        pet: { select: { id: true, name: true, species: true } },
        client: { select: { id: true, fullName: true } },
        doctor: { select: { id: true, name: true, title: true } },
      },
    });
    logAudit("prescription_create", created.id, `Rx ${created.rxNumber} for ${created.petName}`);
    res.status(201).json(created);
  } catch (e) {
    log.error({ err: e }, "failed to create prescription");
    res.status(500).json({ error: "Failed to create prescription" });
  }
});

router.patch("/:id", authenticateUser, requireStaff, validate(updatePrescriptionSchema), async (req, res) => {
  const { id } = req.validated.params;
  const b = req.validated.body;
  try {
    const existing = await prisma.prescription.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Prescription not found" });

    const data = {};
    if (b.status === "void") {
      data.status = "void";
    } else {
      if (b.diagnosis !== undefined) data.diagnosis = b.diagnosis;
      if (b.items !== undefined) data.items = b.items;
      if (b.instructions !== undefined) data.instructions = b.instructions;
      if (b.followUpDate !== undefined) data.followUpDate = b.followUpDate;
      if (existing.status !== "issued") {
        data.status = "issued";
        data.issuedAt = new Date();
        const doctor = await prisma.doctor.findUnique({ where: { id: existing.doctorId } });
        data.signatureSnapshot = {
          name: doctor?.name ?? "",
          title: doctor?.title ?? "",
          licenseNumber: doctor?.licenseNumber ?? "",
          signatureImage: doctor?.signatureImage ?? "",
        };
      }
    }
    const updated = await prisma.prescription.update({ where: { id }, data });
    logAudit("prescription_update", id, `Rx ${updated.rxNumber} updated`);
    res.json(updated);
  } catch (e) {
    log.error({ err: e }, "failed to update prescription");
    res.status(404).json({ error: "Prescription not found" });
  }
});

export default router;