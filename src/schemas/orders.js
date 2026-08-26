import { z } from "zod";

export const createOrderSchema = z.object({
  body: z.object({
    customerName: z.string().min(1).max(120),
    phone: z.string().min(1).max(40),
    email: z.string().max(120).optional().default(""),
    address: z.string().max(500).optional().default(""),
    items: z.array(z.object({
      id: z.string().min(1),
      qty: z.number().int().positive(),
    })).min(1, "Cart is empty"),
    paymentMethod: z.enum(["cash", "fawry", "instapay"]).optional().default("cash"),
    paymentRef: z.string().max(120).optional().default(""),
    proofImage: z.string().optional().default(""),
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
  }),
});
