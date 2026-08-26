import { z } from "zod";

export const createTaskSchema = z.object({
  body: z.object({
    title: z.string().min(1, "Title is required"),
    description: z.string().optional().nullable(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional().default("medium"),
    status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional().default("open"),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    assignedToId: z.string().min(1, "assignedToId is required"),
  }),
});

export const updateTaskSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    status: z.enum(["open", "in_progress", "completed", "cancelled"]).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    assignedToId: z.string().optional(),
  }),
});

export const updateTaskStatusSchema = z.object({
  params: z.object({ id: z.string() }),
  body: z.object({
    status: z.enum(["open", "in_progress", "completed", "cancelled"]),
  }),
});
