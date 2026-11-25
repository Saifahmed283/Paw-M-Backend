import { z } from "zod";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));

export const createWithdrawalSchema = z.object({
  body: z.object({
    date: date.optional(),
    amount: z.number().positive("Amount must be greater than zero").max(1_000_000_000),
    note: z.string().trim().min(3, "A reason is required").max(500),
  }),
});

export const reviewWithdrawalSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    note: z.string().trim().max(500).optional().default(""),
  }),
});

export const rejectWithdrawalSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    reason: z.string().trim().min(3, "A reason is required").max(500),
  }),
});
