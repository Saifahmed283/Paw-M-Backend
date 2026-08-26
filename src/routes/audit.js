import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { parsePagination, paginatedResponse } from "../lib/pagination.js";
import { authenticateUser, requireAdmin } from "../middleware/auth.js";

const router = Router();
const log = logger.child({ module: "routes/audit" });

router.get("/", authenticateUser, requireAdmin, async (req, res) => {
  try {
    const p = parsePagination(req.query);
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        skip: p.skip,
        take: p.limit,
      }),
      prisma.auditLog.count(),
    ]);
    res.json(paginatedResponse(logs, total, p));
  } catch (e) {
    log.error({ err: e }, "failed to load audit logs");
    res.status(500).json({ error: "Failed to load audit logs" });
  }
});

export default router;
