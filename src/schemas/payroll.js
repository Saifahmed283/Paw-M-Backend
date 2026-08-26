import { z } from "zod";

export const calculatePayrollSchema = z.object({
  body: z.object({
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  }),
});

export const payrollRecordStatusSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    status: z.enum(["calculated", "pending_approval", "approved", "paid", "rejected"]),
  }),
});

export const payrollRecordAmountSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    basePay: z.number().nonnegative().optional(),
    commissionPay: z.number().nonnegative().optional(),
    totalBonuses: z.number().nonnegative().optional(),
    totalDeductions: z.number().nonnegative().optional(),
  }),
});

export const bonusDeductionRequestSchema = z.object({
  params: z.object({ recordId: z.string() }),
  body: z.object({
    amount: z.number().positive("Amount must be positive"),
    reason: z.string().min(1, "Reason is required"),
    workSessionId: z.string().optional().nullable(),
  }),
});

export const reviewRequestSchema = z.object({
  params: z.object({ requestId: z.string() }),
  body: z.object({
    status: z.enum(["approved", "rejected"]),
    adminComment: z.string().optional().nullable(),
  }),
});
