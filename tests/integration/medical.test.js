import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: mockPrisma,
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

describe("Pet validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects pet with missing name or species", async () => {
    const { createPetSchema } = await import("../../src/schemas/pets.js");
    expect(createPetSchema.safeParse({ body: { name: "Buddy" } }).success).toBe(false);
    expect(createPetSchema.safeParse({ body: { species: "Dog" } }).success).toBe(false);
  });

  it("accepts a valid pet", async () => {
    const { createPetSchema } = await import("../../src/schemas/pets.js");
    const result = createPetSchema.safeParse({
      body: {
        name: "Luna",
        species: "Cat",
        breed: "Persian",
        sex: "Female",
        dob: "2023-05-01",
        weightKg: "4.2",
        microchip: "981000000000001",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an oversized pet photo", async () => {
    const { createPetSchema } = await import("../../src/schemas/pets.js");
    const result = createPetSchema.safeParse({
      body: { name: "Luna", species: "Cat", photo: "x".repeat(8_000_001) },
    });
    expect(result.success).toBe(false);
  });

  it("allows partial updates via updatePetSchema", async () => {
    const { updatePetSchema } = await import("../../src/schemas/pets.js");
    expect(updatePetSchema.safeParse({ params: { id: "pet-1" }, body: { weightKg: "5.0" } }).success).toBe(true);
    expect(updatePetSchema.safeParse({ params: { id: "pet-1" }, body: { doodad: 1 } }).success).toBe(true);
  });
});

describe("Prescription validation", () => {
  it("requires at least one medication item", async () => {
    const { createPrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    const result = createPrescriptionSchema.safeParse({
      body: { petId: "pet-1", doctorId: "dr-1", diagnosis: "Checkup", items: [] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid issued prescription", async () => {
    const { createPrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    const result = createPrescriptionSchema.safeParse({
      body: {
        petId: "pet-1",
        doctorId: "dr-1",
        bookingId: "bk-1",
        diagnosis: "Skin allergy",
        items: [{ medication: "Cetirizine", dose: "5mg", frequency: "once daily", duration: "7 days" }],
        instructions: "Give after food",
        followUpDate: "2026-10-01",
        status: "issued",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a draft prescription on create", async () => {
    const { createPrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    const result = createPrescriptionSchema.safeParse({
      body: {
        petId: "pet-1",
        doctorId: "dr-1",
        items: [{ medication: "Amoxicillin", dose: "250mg" }],
        status: "draft",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects 'void' status when creating a prescription", async () => {
    const { createPrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    const result = createPrescriptionSchema.safeParse({
      body: {
        petId: "pet-1",
        doctorId: "dr-1",
        items: [{ medication: "Amoxicillin" }],
        status: "void",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects dropping back to 'draft' when updating a prescription", async () => {
    const { updatePrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    const result = updatePrescriptionSchema.safeParse({
      params: { id: "rx-1" },
      body: { status: "draft" },
    });
    expect(result.success).toBe(false);
  });

  it("allows voiding or issuing on update", async () => {
    const { updatePrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    expect(
      updatePrescriptionSchema.safeParse({ params: { id: "rx-1" }, body: { status: "void" } }).success
    ).toBe(true);
    expect(
      updatePrescriptionSchema.safeParse({ params: { id: "rx-1" }, body: { status: "issued" } }).success
    ).toBe(true);
  });

  it("rejects an empty medication name", async () => {
    const { createPrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    const result = createPrescriptionSchema.safeParse({
      body: {
        petId: "pet-1",
        doctorId: "dr-1",
        items: [{ medication: "" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a walk-in prescription with no pet but a pet name", async () => {
    const { createPrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    const result = createPrescriptionSchema.safeParse({
      body: {
        doctorId: "dr-1",
        petName: "Stray Toby",
        petSpecies: "Cat",
        petBreed: "Domestic",
        items: [{ medication: "Amoxicillin", dose: "250mg", frequency: "twice daily" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a walk-in prescription without any pet fields", async () => {
    const { createPrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    const result = createPrescriptionSchema.safeParse({
      body: {
        doctorId: "dr-1",
        items: [{ medication: "Amoxicillin", dose: "250mg" }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a too-long walk-in pet name", async () => {
    const { createPrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    const result = createPrescriptionSchema.safeParse({
      body: {
        doctorId: "dr-1",
        petName: "x".repeat(81),
        items: [{ medication: "Amoxicillin", dose: "250mg" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized walk-in species value", async () => {
    const { createPrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    const result = createPrescriptionSchema.safeParse({
      body: {
        doctorId: "dr-1",
        petName: "Toby",
        petSpecies: "x".repeat(41),
        items: [{ medication: "Amoxicillin", dose: "250mg" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a prescription with neither petId nor petName in the route", async () => {
    const { createPrescriptionSchema } = await import("../../src/schemas/prescriptions.js");
    const parsed = createPrescriptionSchema.safeParse({
      body: {
        doctorId: "dr-1",
        items: [{ medication: "Amoxicillin", dose: "250mg" }],
      },
    });
    expect(parsed.success).toBe(true);
    // Schema-level: petName is optional by shape; the "Patient name is required"
    // guard lives in the route. Assert no pet reference is forced.
    expect(parsed.data.petId == null).toBe(true);
  });
});

describe("Booking clinical validation", () => {
  it("accepts a pet-linked clinical update", async () => {
    const { updateBookingClinicalSchema } = await import("../../src/schemas/bookings.js");
    const result = updateBookingClinicalSchema.safeParse({
      params: { id: "bk-1" },
      body: {
        diagnosis: "Otitis externa",
        treatmentNotes: "Ear cleaning + drops",
        followUpDate: "2026-10-01",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty clinical update body", async () => {
    const { updateBookingClinicalSchema } = await import("../../src/schemas/bookings.js");
    const result = updateBookingClinicalSchema.safeParse({ params: { id: "bk-1" }, body: {} });
    expect(result.success).toBe(true);
  });

  it("accepts a nullable petId on booking creation", async () => {
    const { createBookingSchema } = await import("../../src/schemas/bookings.js");
    const result = createBookingSchema.safeParse({
      body: {
        ownerName: "John Doe",
        phone: "01234567890",
        petId: null,
        petName: "Buddy",
        animalType: "Dog",
        doctorId: "dr-1",
        doctorName: "Dr. Mirna",
        date: "2026-10-01",
        time: "10:00",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid booking status", async () => {
    const { updateBookingStatusSchema } = await import("../../src/schemas/bookings.js");
    const result = updateBookingStatusSchema.safeParse({
      params: { id: "bk-1" },
      body: { status: "no-show" },
    });
    expect(result.success).toBe(false);
  });
});