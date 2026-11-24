import { z } from "zod";

export const createClientSchema = z.object({
  body: z.object({
    fullName: z.string().trim().min(1).max(120),
    email: z.string().trim().email().transform((value) => value.toLowerCase()),
    phone: z.string().trim().max(40).optional().default(""),
    password: z.string().min(6).max(200),
  }),
});

export const notifyClientSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(2000),
  }),
});

export const updateClientSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    suspended: z.boolean().optional(),
  }),
});