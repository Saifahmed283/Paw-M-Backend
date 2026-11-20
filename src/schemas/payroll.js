import { z } from "zod";

const periodDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

const amountFields = {
  basePay: z.number().nonnegative().optional(),
  commissionPay: z.number().nonnegative().optional(),
  totalBonuses: z.number().nonnegative().optional(),
  totalDeductions: z.number().nonnegative().optional(),
};

export const calculatePayrollSchema = z
  .object({
    body: z.object({
      periodStart: periodDate,
      periodEnd: periodDate,
    }),
  })
  .refine((v) => v.body.periodStart <= v.body.periodEnd, {
    message: "periodStart must be on or before periodEnd",
    path: ["body", "periodStart"],
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
    ...amountFields,
    notes: z.string().max(2000).optional(),
  }),
});

/** Admin/payroll can add an off-cycle record for an employee with no sessions. */
export const createPayrollRecordSchema = z
  .object({
    body: z.object({
      employeeId: z.string().min(1, "Employee is required"),
      periodStart: periodDate,
      periodEnd: periodDate,
      ...amountFields,
      notes: z.string().max(2000).optional(),
    }),
  })
  .refine((v) => v.body.periodStart <= v.body.periodEnd, {
    message: "periodStart must be on or before periodEnd",
    path: ["body", "periodStart"],
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
    adminComment: z.string().max(1000).optional().nullable(),
  }),
});

export const payrollNotifySchema = z.object({
  body: z.object({
    periodStart: periodDate,
    periodEnd: periodDate,
  }),
});
