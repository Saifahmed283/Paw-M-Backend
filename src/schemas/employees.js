import { z } from "zod";

export const createEmployeeSchema = z.object({
  body: z.object({
    fullName: z.string().min(1, "Full name is required"),
    email: z.string().email("Invalid email"),
    phone: z.string().optional().nullable(),
    role: z.enum(["admin", "payroll", "staff"]),
    payRateType: z.enum(["hourly", "monthly"]).optional().default("hourly"),
    hourlyRate: z.number().nonnegative().optional().default(0),
    monthlySalary: z.number().nonnegative().optional().default(0),
    roleHoursPerDay: z.number().int().positive().optional().default(8),
    commissionRates: z.record(z.number()).optional().default({}),
    isActive: z.boolean().optional().default(true),
  }),
});

export const updateEmployeeSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    fullName: z.string().min(1).optional(),
    email: z.string().email().optional(),
    phone: z.string().nullable().optional(),
    role: z.enum(["admin", "payroll", "staff"]).optional(),
    payRateType: z.enum(["hourly", "monthly"]).optional(),
    hourlyRate: z.number().nonnegative().optional(),
    monthlySalary: z.number().nonnegative().optional(),
    roleHoursPerDay: z.number().int().positive().optional(),
    commissionRates: z.record(z.number()).optional(),
    isActive: z.boolean().optional(),
  }),
});
