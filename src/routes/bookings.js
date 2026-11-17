import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit, nextId } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireStaff, optionalClientAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createBookingSchema, updateBookingStatusSchema, updateBookingClinicalSchema } from "../schemas/bookings.js";
import { createBroadcastNotification } from "../lib/notify.js";
import { attributeSaleToActiveSession } from "../services/session-attribution.js";

const router = Router();
const log = logger.child({ module: "routes/bookings" });

router.get("/", authenticateUser, requireStaff, async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({ orderBy: { createdAt: "desc" }, skip: p.skip, take: p.limit }),
      prisma.booking.count(),
    ]);
    res.json(paginatedResponse(bookings, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to fetch bookings");
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
});

router.post("/", optionalClientAuth, validate(createBookingSchema), async (req, res) => {
  const b = req.validated.body;
  try {
    const isGuest = !req.client;

    // Guests have no account, so an email is the only way to reach them with a
    // confirmation. Saved pets belong to accounts and cannot be referenced by
    // an anonymous booking — the form already forces guests to enter pet details.
    if (isGuest && !b.email?.trim()) {
      return res.status(400).json({ error: "Email is required for guest bookings." });
    }
    if (isGuest && b.petId) {
      return res.status(400).json({ error: "Saved pets are only available to signed-in clients." });
    }

    const conflict = await prisma.booking.findFirst({
      where: {
        doctorId: b.doctorId,
        date: b.date,
        time: b.time,
        status: { not: "cancelled" },
      },
    });
    if (conflict) {
      return res.status(409).json({ error: "This doctor is already booked at the requested date and time. Please choose a different slot." });
    }

    let petId = b.petId ?? null;
    if (petId) {
      const pet = await prisma.pet.findUnique({ where: { id: petId } });
      if (!pet || pet.clientId !== req.client.id) {
        return res.status(400).json({ error: "Pet not found for this account" });
      }
    }

    const record = await prisma.booking.create({
      data: {
        id: await nextId("REQ", "booking"),
        clientId: req.client?.id ?? null,
        petId,
        ownerName: b.ownerName,
        phone: b.phone,
        email: b.email,
        petName: b.petName,
        animalType: b.animalType,
        breed: b.breed,
        age: b.age,
        weight: b.weight,
        symptoms: b.symptoms,
        allergies: b.allergies,
        medications: b.medications,
        doctorId: b.doctorId,
        doctorName: b.doctorName,
        date: b.date,
        time: b.time,
        emergency: b.emergency,
      },
    });
    createBroadcastNotification(prisma, {
      type: "booking",
      title: "New booking request",
      body: `${record.ownerName} booked ${record.petName} with ${record.doctorName} on ${record.date} at ${record.time}.`,
      data: { bookingId: record.id },
    }).catch(() => {});
    res.status(201).json(record);
  } catch (e) {
    log.error({ err: e }, "failed to create booking");
    res.status(500).json({ error: "Failed to create booking" });
  }
});

router.patch("/:id/status", authenticateUser, requireStaff, validate(updateBookingStatusSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { status } = req.validated.body;
  try {
    const existing = await prisma.booking.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Booking not found" });

    const { sendMail, buildBookingConfirmedEmail, buildBookingCancelledEmail } = await import("../lib/email.js");

    const updated = await prisma.booking.update({ where: { id }, data: { status } });
    logAudit("booking_status", id, `${updated.ownerName}'s booking → ${status}`);

    if (status === "completed") {
      attributeSaleToActiveSession(req, { bookings: 1 }).catch(() => {});
    }

    const clinicSettings = await prisma.clinicSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    const clinicName = clinicSettings?.name || "Paw-M Clinic";

    if (status === "confirmed" && existing.email) {
      sendMail(buildBookingConfirmedEmail({
        to: existing.email, ownerName: updated.ownerName, petName: updated.petName,
        doctorName: updated.doctorName, date: updated.date, time: updated.time,
        phone: existing.phone, clinicName,
      })).catch(() => {});
    } else if (status === "cancelled" && existing.email) {
      sendMail(buildBookingCancelledEmail({
        to: existing.email, ownerName: updated.ownerName, petName: updated.petName,
        doctorName: updated.doctorName, date: updated.date, time: updated.time, clinicName,
      })).catch(() => {});
    }
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Booking not found" });
  }
});

router.delete("/:id", authenticateUser, requireStaff, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.booking.findUnique({ where: { id } });
    await prisma.booking.delete({ where: { id } });
    logAudit("booking_delete", id, `Deleted booking for ${existing?.ownerName ?? "unknown"}`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Booking not found" });
  }
});

router.patch("/:id/clinical", authenticateUser, requireStaff, validate(updateBookingClinicalSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { diagnosis, treatmentNotes, followUpDate } = req.validated.body;
  try {
    const existing = await prisma.booking.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Booking not found" });

    const updated = await prisma.booking.update({
      where: { id },
      data: { diagnosis, treatmentNotes, followUpDate },
    });
    logAudit("booking_clinical", id, `Clinical record saved for ${updated.petName} · ${updated.doctorName}`);
    res.json(updated);
  } catch (e) {
    log.error({ err: e }, "failed to save booking clinical record");
    res.status(404).json({ error: "Booking not found" });
  }
});

router.patch("/:id/archive", authenticateUser, requireStaff, async (req, res) => {
  const { id } = req.params;
  const archived = req.body?.archived === true;
  try {
    const updated = await prisma.booking.update({ where: { id }, data: { archived } });
    logAudit(archived ? "booking_archive" : "booking_restore", id, `${updated.ownerName}'s booking ${archived ? "archived" : "restored"}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Booking not found" });
  }
});

export default router;
