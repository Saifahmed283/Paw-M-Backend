import { z } from "zod";

export const notifyClientSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(2000),
  }),
});

export const updateClientSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    suspended: z.boolean().optional(),
  }),
});