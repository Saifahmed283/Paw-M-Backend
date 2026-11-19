import { z } from "zod";

const usernameSchema = z
  .string()
  .min(3, "Username must be at least 3 characters")
  .transform((v) => v.trim().toLowerCase());
const passwordSchema = z.string().min(6, "Password must be at least 6 characters");
const roleSchema = z.enum(["admin", "payroll", "staff"]);
const accountIdParams = z.object({ id: z.coerce.number().int().positive("Invalid account id") });

export const loginSchema = z.object({
  body: z.object({
    username: z.string().min(1, "Username is required"),
    password: z.string().min(1, "Password is required"),
  }),
});

export const registerSchema = z.object({
  body: z.object({
    username: z.string().min(3, "Username must be at least 3 characters"),
    password: passwordSchema,
  }),
});

export const changeCredentialsSchema = z.object({
  body: z
    .object({
      currentPassword: z.string().min(1, "Current password is required"),
      newUsername: z.string().min(3).optional(),
      newPassword: z.string().min(6).optional(),
    })
    .refine((data) => data.newUsername !== undefined || data.newPassword !== undefined, {
      message: "Nothing to change",
    }),
});

export const createAccountSchema = z.object({
  body: z.object({
    username: usernameSchema,
    password: passwordSchema,
    role: roleSchema,
  }),
});

export const updateAccountRoleSchema = z.object({
  params: accountIdParams,
  body: z.object({
    role: roleSchema,
  }),
});

export const updateAccountSchema = z.object({
  params: accountIdParams,
  body: z
    .object({
      username: usernameSchema.optional(),
      password: passwordSchema.optional(),
      role: roleSchema.optional(),
      isActive: z.boolean().optional(),
    })
    .refine(
      (data) =>
        data.username !== undefined ||
        data.password !== undefined ||
        data.role !== undefined ||
        data.isActive !== undefined,
      { message: "Nothing to change" },
    ),
});

export const accountIdParamSchema = z.object({
  params: accountIdParams,
});
