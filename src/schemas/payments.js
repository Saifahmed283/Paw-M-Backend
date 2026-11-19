import { z } from "zod";

// Line items are normally positive; a negative `other` line represents a
// discount (sale creation posts one, so manual/visit payments must be able to).
export const paymentItemSchema = z
  .object({
    label: z.string().min(1).max(200),
    amount: z.number().min(-1_000_000, "Amount is out of range"),
    kind: z.enum(["service", "product", "other"]).optional().default("service"),
    referenceId: z
      .string()
      .max(80)
      .nullish()
      .transform((v) => v ?? ""),
  })
  .superRefine((item, ctx) => {
    if (item.amount < 0 && item.kind !== "other") {
      ctx.addIssue({
        code: "custom",
        message: "Only discount (other) items may be negative",
        path: ["amount"],
      });
    }
  });

const paymentStatusSchema = z.enum(["unpaid", "proof_submitted", "paid"]);

export const createPaymentSchema = z.object({
  body: z.object({
    title: z.string().min(1).max(200),
    amount: z.number().positive("Amount must be positive").optional(),
    method: z.enum(["cash", "fawry", "instapay"]).optional().default("cash"),
    status: paymentStatusSchema.optional().default("unpaid"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
    notes: z.string().max(1000).optional().default(""),
    orderId: z.string().max(60).optional().default(""),
    clientId: z.string().max(80).optional(),
    bookingId: z.string().max(80).optional(),
    kind: z.enum(["order", "visit", "manual"]).optional().default("order"),
    requestedBy: z.string().max(120).optional().default(""),
    items: z.array(paymentItemSchema).max(50).optional(),
  }),
});

export const addPaymentItemsSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    items: z.array(paymentItemSchema).min(1).max(50),
  }),
});

export const settlePaymentSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    method: z.enum(["cash", "fawry", "instapay"]).optional(),
    notes: z.string().max(1000).optional(),
  }),
});

export const updatePaymentSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    amount: z.number().positive().optional(),
    method: z.enum(["cash", "fawry", "instapay"]).optional(),
    status: paymentStatusSchema.optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    notes: z.string().max(1000).optional(),
    orderId: z.string().max(60).optional(),
    clientId: z.string().max(80).optional(),
    bookingId: z.string().max(80).optional(),
    kind: z.enum(["order", "visit", "manual"]).optional(),
    requestedBy: z.string().max(120).optional(),
  }),
});