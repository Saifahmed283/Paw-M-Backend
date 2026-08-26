import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireAdmin } from "../middleware/auth.js";

const router = Router();
const log = logger.child({ module: "routes/audit" });

router.get("/", authenticateUser, requireAdmin, async (_req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    res.json(logs);
  } catch (e) {
    log.error({ err: e }, "failed to load audit logs");
    res.status(500).json({ error: "Failed to load audit logs" });
  }
});

export default router;
