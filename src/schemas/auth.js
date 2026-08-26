import { z } from "zod";

export const loginSchema = z.object({
  body: z.object({
    username: z.string().min(1, "Username is required"),
    password: z.string().min(1, "Password is required"),
  }),
});

export const registerSchema = z.object({
  body: z.object({
    username: z.string().min(3, "Username must be at least 3 characters"),
    password: z.string().min(6, "Password must be at least 6 characters"),
  }),
});

export const changeCredentialsSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, "Current password is required"),
    newUsername: z.string().min(3).optional(),
    newPassword: z.string().min(6).optional(),
  }).refine((data) => data.newUsername !== undefined || data.newPassword !== undefined, {
    message: "Nothing to change",
  }),
});
