import { z } from "zod";

export const createBookingSchema = z.object({
  body: z.object({
    ownerName: z.string().min(1).max(120),
    phone: z.string().min(1).max(40),
    email: z.string().max(120).optional().default(""),
    petName: z.string().min(1).max(80),
    animalType: z.string().max(40),
    breed: z.string().max(60).optional().default(""),
    age: z.string().max(20).optional().default(""),
    weight: z.string().max(20).optional().default(""),
    symptoms: z.string().max(1000).optional().default(""),
    allergies: z.string().max(1000).optional().default(""),
    medications: z.string().max(1000).optional().default(""),
    doctorId: z.string().max(60),
    doctorName: z.string().max(120),
    date: z.string().max(20),
    time: z.string().max(10),
    emergency: z.boolean().optional().default(false),
  }),
});

export const updateBookingStatusSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    status: z.enum(["pending", "confirmed", "completed", "cancelled"]),
  }),
});
