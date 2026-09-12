import { z } from "zod";

export const rxItemSchema = z.object({
  medication: z.string().min(1).max(200),
  dose: z.string().max(120).optional().default(""),
  frequency: z.string().max(120).optional().default(""),
  route: z.string().max(120).optional().default(""),
  duration: z.string().max(120).optional().default(""),
  note: z.string().max(500).optional().default(""),
});

export const createPrescriptionSchema = z.object({
  body: z.object({
    petId: z.string().max(60).nullable().optional().default(null),
    petName: z.string().max(80).optional().default(""),
    petSpecies: z.string().max(40).optional().default(""),
    petBreed: z.string().max(60).optional().default(""),
    doctorId: z.string().min(1).max(60),
    bookingId: z.string().max(60).nullable().optional().default(null),
    diagnosis: z.string().max(2000).optional().default(""),
    items: z.array(rxItemSchema).min(1, "At least one medication is required").max(30),
    instructions: z.string().max(2000).optional().default(""),
    followUpDate: z.string().max(20).optional().default(""),
    status: z.enum(["draft", "issued"]).optional().default("issued"),
  }),
});

export const updatePrescriptionSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    diagnosis: z.string().max(2000).optional(),
    items: z.array(rxItemSchema).min(1).max(30).optional(),
    instructions: z.string().max(2000).optional(),
    followUpDate: z.string().max(20).optional(),
    status: z.enum(["issued", "void"]).optional(),
  }),
});