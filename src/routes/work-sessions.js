import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { logAudit, archiveFinishedDayRecords, todayStr } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { resolveEmployeeId } from "../lib/resolve-employee.js";
import { authenticateUser, requireStaff } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { cashCustodySchema } from "../schemas/orders.js";

const router = Router();
const log = logger.child({ module: "routes/work-sessions" });
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

router.get("/", authenticateUser, requireStaff, async (req, res) => {
  try {
    const employeeId = await resolveEmployeeId(req.user.id);
    if (!employeeId) return res.json(null);
    const session = await prisma.workSession.findFirst({
      where: { employeeId, endedAt: null },
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
    const employeeId = await resolveEmployeeId(req.user.id);
    if (!employeeId) return res.status(400).json({ error: "No employee profile found for your account." });

    const open = await prisma.workSession.findFirst({
      where: { employeeId, endedAt: null },
      orderBy: { startedAt: "desc" },
    });
    if (open) {
      if (todayStr(open.startedAt) !== todayStr()) {
        const archived = await archiveFinishedDayRecords();
        await prisma.workSession.update({ where: { id: open.id }, data: { endedAt: new Date() } });
        logAudit("check_out", open.id, "Previous shift auto-closed on new check-in");
        logAudit("check_in", "", `Checked in — auto-archived ${archived.bookings} bookings and ${archived.orders} orders`);
        const session = await prisma.workSession.create({ data: { date: todayStr(), employeeId } });
        return res.status(201).json({ session, archived });
      }
      return res.json({ session: open, archived: { bookings: 0, orders: 0 } });
    }
    const session = await prisma.workSession.create({ data: { date: todayStr(), employeeId } });
    logAudit("check_in", session.id, "Checked in");
    res.status(201).json({ session, archived: { bookings: 0, orders: 0 } });
  } catch (e) {
    log.error({ err: e }, "check-in failed");
    res.status(500).json({ error: "Failed to check in" });
  }
});

router.post("/check-out", authenticateUser, requireStaff, async (req, res) => {
  try {
    const employeeId = await resolveEmployeeId(req.user.id);
    if (!employeeId) return res.status(400).json({ error: "No employee profile found for your account." });

    const open = await prisma.workSession.findFirst({
      where: { employeeId, endedAt: null },
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

/** The caller's start-of-shift cash custody declaration, or null. */
async function currentCustody(employeeId) {
  const session = await prisma.workSession.findFirst({
    where: { employeeId, endedAt: null },
    orderBy: { startedAt: "desc" },
  });
  if (!session) return null;
  return prisma.cashCustody.findUnique({ where: { workSessionId: session.id } });
}

router.get("/custody", authenticateUser, requireStaff, async (req, res) => {
  try {
    const employeeId = await resolveEmployeeId(req.user.id);
    if (!employeeId) return res.json(null);
    res.json((await currentCustody(employeeId)) ?? null);
  } catch (e) {
    log.error({ err: e }, "failed to fetch cash custody");
    res.status(500).json({ error: "Failed to fetch cash custody" });
  }
});

router.post("/custody", authenticateUser, requireStaff, validate(cashCustodySchema), async (req, res) => {
  try {
    const employeeId = await resolveEmployeeId(req.user.id);
    if (!employeeId) return res.status(400).json({ error: "No employee profile found for your account." });

    const session = await prisma.workSession.findFirst({
      where: { employeeId, endedAt: null },
      orderBy: { startedAt: "desc" },
    });
    if (!session) return res.status(400).json({ error: "You are not checked in." });

    const { hasDrawer, openingAmount, note } = req.validated.body;
    const amount = hasDrawer ? round2(openingAmount) : 0;

    // Idempotent: a second submission for the same shift returns the
    // original declaration rather than creating a duplicate.
    const existing = await prisma.cashCustody.findUnique({ where: { workSessionId: session.id } });
    if (existing) return res.json(existing);

    let custody;
    try {
      custody = await prisma.cashCustody.create({
        data: {
          workSessionId: session.id,
          employeeId,
          date: todayStr(),
          hasDrawer,
          openingAmount: amount,
          note: note.trim(),
        },
      });
    } catch (e) {
      // A concurrent double-submit can win the unique race; return the winner.
      if (e?.code === "P2002") {
        return res.json((await currentCustody(employeeId)) ?? { workSessionId: session.id });
      }
      throw e;
    }
    logAudit("cash_custody_recorded", session.id, `Custody declared: drawer=${hasDrawer ? "yes" : "no"}, opening=${amount} by staff #${req.user.id}`);
    res.status(201).json(custody);
  } catch (e) {
    log.error({ err: e }, "failed to record cash custody");
    res.status(500).json({ error: "Failed to record cash custody" });
  }
});

export default router;
