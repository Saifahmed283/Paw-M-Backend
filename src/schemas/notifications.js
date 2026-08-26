import { z } from "zod";

export const createNotificationSchema = z.object({
  body: z.object({
    type: z.string().min(1, "Type is required"),
    title: z.string().min(1, "Title is required"),
    body: z.string().min(1, "Body is required"),
    data: z.any().optional().nullable(),
  }),
});
