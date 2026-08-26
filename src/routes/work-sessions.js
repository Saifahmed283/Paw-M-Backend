import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit, archiveFinishedDayRecords, todayStr } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireStaff } from "../middleware/auth.js";

const router = Router();
const log = logger.child({ module: "routes/work-sessions" });

router.get("/", authenticateUser, requireStaff, async (req, res) => {
  try {
    const session = await prisma.workSession.findFirst({
      where: { employeeId: req.user.id, endedAt: null },
      orderBy: { startedAt: "desc" },
    });
    res.json(session ?? null);
  } catch (e) {
    log.error({ err: e }, "failed to fetch work session");
    res.status(500).json({ error: "Failed to fetch work session" });
  }
});

router.post("/check-in", authenticateUser, requireStaff, async (req, res) => {
  try {
    const open = await prisma.workSession.findFirst({
      where: { employeeId: req.user.id, endedAt: null },
      orderBy: { startedAt: "desc" },
    });
    if (open) {
      if (todayStr(open.startedAt) !== todayStr()) {
        const archived = await archiveFinishedDayRecords();
        await prisma.workSession.update({ where: { id: open.id }, data: { endedAt: new Date() } });
        logAudit("check_out", open.id, "Previous shift auto-closed on new check-in");
        logAudit("check_in", "", `Checked in — auto-archived ${archived.bookings} bookings and ${archived.orders} orders`);
        const session = await prisma.workSession.create({ data: { date: todayStr(), employeeId: req.user.id } });
        return res.status(201).json({ session, archived });
      }
      return res.json({ session: open, archived: { bookings: 0, orders: 0 } });
    }
    const session = await prisma.workSession.create({ data: { date: todayStr(), employeeId: req.user.id } });
    logAudit("check_in", session.id, "Checked in");
    res.status(201).json({ session, archived: { bookings: 0, orders: 0 } });
  } catch (e) {
    log.error({ err: e }, "check-in failed");
    res.status(500).json({ error: "Failed to check in" });
  }
});

router.post("/check-out", authenticateUser, requireStaff, async (req, res) => {
  try {
    const open = await prisma.workSession.findFirst({
      where: { employeeId: req.user.id, endedAt: null },
      orderBy: { startedAt: "desc" },
    });
    if (!open) return res.status(400).json({ error: "You are not checked in." });
    const archived = await archiveFinishedDayRecords();
    const ended = await prisma.workSession.update({
      where: { id: open.id },
      data: { endedAt: new Date() },
    });
    logAudit("check_out", open.id, `Checked out — archived ${archived.bookings} bookings and ${archived.orders} orders`);
    res.json({ session: ended, archived });
  } catch (e) {
    log.error({ err: e }, "check-out failed");
    res.status(500).json({ error: "Failed to check out" });
  }
});

export default router;
