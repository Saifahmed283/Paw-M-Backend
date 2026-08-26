import { z } from "zod";

export const createPaymentSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(200),
    amount: z.number().positive("Amount must be positive"),
    method: z.enum(["cash", "fawry", "instapay"]).optional().default("cash"),
    status: z.enum(["unpaid", "paid"]).optional().default("unpaid"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
    notes: z.string().max(1000).optional().default(""),
    orderId: z.string().max(60).optional().default(""),
  }),
});

export const updatePaymentSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    amount: z.number().positive().optional(),
    method: z.enum(["cash", "fawry", "instapay"]).optional(),
    status: z.enum(["unpaid", "paid"]).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    notes: z.string().max(1000).optional(),
    orderId: z.string().max(60).optional(),
  }),
});
