import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireAdmin, requireStaff } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { createTaskSchema, updateTaskSchema, updateTaskStatusSchema } from "../schemas/tasks.js";

const router = Router();
const log = logger.child({ module: "routes/tasks" });

router.post("/", authenticateUser, requireAdmin, validate(createTaskSchema), async (req, res) => {
  try {
    const { title, description, priority, status, dueDate, assignedToId } = req.validated.body;
    const employee = await prisma.employee.findUnique({ where: { id: assignedToId } });
    if (!employee) return res.status(400).json({ error: "Assigned employee not found" });
    const task = await prisma.adminTask.create({
      data: {
        title, description: description || null, priority, status,
        dueDate: dueDate || null, assignedBy: req.user.username, assignedToId,
      },
    });
    res.status(201).json(task);
  } catch (error) {
    log.error({ err: error }, "failed to create task");
    res.status(500).json({ error: "Failed to create task" });
  }
});

router.get("/mine", authenticateUser, requireStaff, async (req, res) => {
  try {
    const tasks = await prisma.adminTask.findMany({
      where: { assignedToId: req.user.id },
      orderBy: { createdAt: "desc" },
    });
    res.json(tasks);
  } catch (error) {
    log.error({ err: error }, "failed to fetch tasks");
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

router.get("/all", authenticateUser, requireAdmin, async (_req, res) => {
  try {
    const tasks = await prisma.adminTask.findMany({ orderBy: { createdAt: "desc" } });
    res.json(tasks);
  } catch (error) {
    log.error({ err: error }, "failed to fetch tasks");
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

router.patch("/:id", authenticateUser, requireAdmin, validate(updateTaskSchema), async (req, res) => {
  const { id } = req.validated.params;
  const data = req.validated.body;
  try {
    const existing = await prisma.adminTask.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Task not found" });
    if (data.assignedToId) {
      const employee = await prisma.employee.findUnique({ where: { id: data.assignedToId } });
      if (!employee) return res.status(400).json({ error: "Assigned employee not found" });
    }
    const task = await prisma.adminTask.update({
      where: { id },
      data: {
        title: data.title, description: data.description ?? null,
        priority: data.priority, status: data.status,
        dueDate: data.dueDate ?? null, assignedToId: data.assignedToId,
        updatedAt: new Date(),
      },
    });
    res.json(task);
  } catch (error) {
    log.error({ err: error }, "failed to update task");
    res.status(500).json({ error: "Failed to update task" });
  }
});

router.patch("/:id/status", authenticateUser, requireStaff, validate(updateTaskStatusSchema), async (req, res) => {
  const { id } = req.validated.params;
  const { status } = req.validated.body;
  try {
    const task = await prisma.adminTask.findUnique({ where: { id, assignedToId: req.user.id } });
    if (!task) return res.status(404).json({ error: "Task not found or not assigned to you" });
    const updatedTask = await prisma.adminTask.update({
      where: { id }, data: { status, updatedAt: new Date() },
    });
    res.json(updatedTask);
  } catch (error) {
    log.error({ err: error }, "failed to update task status");
    res.status(500).json({ error: "Failed to update task status" });
  }
});

export default router;
