import { z } from "zod";

export const contactSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters").max(100),
    email: z.string().email("Invalid email address"),
    phone: z.string().min(6, "Phone number too short").max(20).optional(),
    subject: z.string().min(3, "Subject must be at least 3 characters").max(200),
    message: z.string().min(10, "Message must be at least 10 characters").max(2000),
  }),
});