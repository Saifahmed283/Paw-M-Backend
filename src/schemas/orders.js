import { z } from "zod";

export const createOrderSchema = z.object({
  body: z.object({
    customerName: z.string().min(1).max(120),
    phone: z.string().max(40).optional().default(""),
    email: z.string().max(120).optional().default(""),
    address: z.string().max(500).optional().default(""),
    items: z.array(z.object({
      id: z.string().min(1),
      qty: z.number().int().positive(),
      price: z.number().nonnegative().optional(),
      name: z.string().max(200).optional(),
    })).min(1, "Cart is empty"),
    paymentMethod: z.enum(["cash", "fawry", "instapay"]).optional().default("cash"),
    paymentRef: z.string().max(120).optional().default(""),
    proofImage: z.string().optional().default(""),
    source: z.enum(["pos", "store"]).optional().default("store"),
    discountAmount: z.number().nonnegative().optional().default(0),
    discountLabel: z.string().max(120).optional().default(""),
  }),
});

export const updateOrderStatusSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    status: z.enum(["pending", "confirmed", "completed", "cancelled"]),
  }),
});

export const updateOrderPaymentSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    paymentStatus: z.enum(["unpaid", "proof_submitted", "paid"]),
    paymentMethod: z.enum(["cash", "fawry", "instapay"]).optional(),
  }),
});

export const submitPaymentProofSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    paymentRef: z.string().max(120).optional().default(""),
    proofImage: z.string().max(8_000_000).optional().default(""),
    phone: z.string().max(40).optional(),
  }),
});

// Omitting `items` (or sending an empty array) means "refund everything still
// refundable". Per-line quantities are checked against prior refunds in the
// refund service, since that depends on stored Payment rows.
export const refundOrderSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    reason: z.string().max(200).optional().default(""),
    items: z.array(z.object({
      id: z.string().min(1).max(60),
      qty: z.number().int().positive(),
    })).optional().default([]),
  }),
});
