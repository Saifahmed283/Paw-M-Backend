import { z } from "zod";

// Checkout no longer accepts a payment reference or proof image. Payment is
// settled later by a trusted verification event (cash confirmation / payment
// proof approval), so client-supplied "paid" signals are rejected as unknown
// fields. Fawry and InstaPay orders both use the proof-verification path.
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
    source: z.enum(["pos", "store"]).optional().default("store"),
    // POS-only: cashier attests that cash was physically received. Ignored for
    // store clients (the route rejects them outright).
    cashReceived: z.boolean().optional().default(false),
    cashReceivedAmount: z.number().nonnegative().optional().default(0),
    discountAmount: z.number().nonnegative().optional().default(0),
    discountLabel: z.string().max(120).optional().default(""),
  }).strict().superRefine((data, ctx) => {
    // A POS sale is tied to a real customer: require a name and a valid phone
    // number so receipts and order tracking always have someone to contact.
    if (data.source !== "pos") return;
    if (data.customerName.trim().length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customerName"],
        message: "A customer name is required",
      });
    }
    const digits = data.phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phone"],
        message: "A valid customer phone number is required",
      });
    }
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
    // "paid" is accepted by the schema only so the route can return an
    // explicit, actionable rejection. It is never written by this endpoint.
    paymentStatus: z.enum(["unpaid", "proof_submitted", "under_review", "paid", "rejected"]),
    paymentMethod: z.enum(["cash", "fawry", "instapay"]).optional(),
  }),
});

export const confirmCashSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    amountReceived: z.number().positive(),
    note: z.string().max(200).optional().default(""),
  }),
});

export const transferSubmissionSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    senderName: z.string().min(2).max(120),
    transferReference: z.string().min(3).max(160),
    // All four proof fields are mandatory: staff match them to the bank
    // statement, so a reference-only claim is not enough to review.
    transferredAt: z.string().datetime(),
    evidenceBase64: z
      .string()
      .min(1, "A payment screenshot is required.")
      .max(8_000_000)
      .refine((v) => v.startsWith("data:image/"), "A payment screenshot is required."),
    note: z.string().max(500).optional().default(""),
    // Guest ownership check (same rule as the legacy /payment-proof route).
    phone: z.string().max(40).optional(),
  }),
});

export const approveTransferSchema = z.object({
  params: z.object({ verificationId: z.string() }),
  body: z.object({
    bankTransactionReference: z.string().min(3).max(160),
    note: z.string().max(500).optional().default(""),
  }),
});

export const rejectTransferSchema = z.object({
  params: z.object({ verificationId: z.string() }),
  body: z.object({
    reason: z.string().min(5).max(500),
  }),
});

export const cashDrawerCloseSchema = z.object({
  body: z.object({
    countedAmount: z.number().nonnegative(),
    note: z.string().max(200).optional().default(""),
  }),
});

// Start-of-shift cash custody & handover. Amount must be zero when no drawer
// was handed over; the route normalises it to 0 for a false `hasDrawer`.
export const cashCustodySchema = z.object({
  body: z.object({
    hasDrawer: z.boolean(),
    openingAmount: z.number().nonnegative().max(1_000_000_000),
    note: z.string().max(200).optional().default(""),
  }),
});

// Legacy endpoint kept as a compatibility shim; it forwards into the
// transfer-submission flow and never stores the image on the Order row.
export const submitPaymentProofSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    paymentRef: z.string().max(160).optional().default(""),
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
