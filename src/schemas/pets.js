import { z } from "zod";

export const createPetSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(80),
    species: z.string().min(1).max(40),
    breed: z.string().max(60).optional().default(""),
    sex: z.string().max(30).optional().default(""),
    dob: z.string().max(20).optional().default(""),
    weightKg: z.string().max(20).optional().default(""),
    color: z.string().max(60).optional().default(""),
    microchip: z.string().max(60).optional().default(""),
    photo: z.string().max(8_000_000).optional().default(""),
    notes: z.string().max(2000).optional().default(""),
  }),
});

export const updatePetSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    name: z.string().min(1).max(80).optional(),
    species: z.string().min(1).max(40).optional(),
    breed: z.string().max(60).optional(),
    sex: z.string().max(30).optional(),
    dob: z.string().max(20).optional(),
    weightKg: z.string().max(20).optional(),
    color: z.string().max(60).optional(),
    microchip: z.string().max(60).optional(),
    photo: z.string().max(8_000_000).optional(),
    notes: z.string().max(2000).optional(),
  }),
});