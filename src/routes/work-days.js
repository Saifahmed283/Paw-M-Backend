import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { todayStr } from "../lib/utils.js";
import { logger } from "../lib/logger.js";
import { authenticateUser, requireStaff } from "../middleware/auth.js";

const router = Router();
const log = logger.child({ module: "routes/work-days" });

router.get("/", authenticateUser, requireStaff, async (_req, res) => {
  try {
    const [bookings, orders, payments, sessions] = await Promise.all([
      prisma.booking.findMany({ select: { id: true, date: true, status: true } }),
      prisma.order.findMany({ select: { id: true, createdAt: true, total: true, status: true } }),
      prisma.payment.findMany({ select: { id: true, date: true, amount: true, status: true } }),
      prisma.workSession.findMany({
        select: { id: true, date: true, startedAt: true, endedAt: true },
        orderBy: { startedAt: "desc" },
      }),
    ]);
    const days = new Map();
    const addDay = (day) => {
      if (!days.has(day)) {
        days.set(day, { date: day, bookings: 0, orders: 0, payments: 0, revenue: 0, paymentsTotal: 0, session: null });
      }
    };
    for (const b of bookings) { addDay(b.date); days.get(b.date).bookings++; }
    for (const o of orders) {
      const day = todayStr(new Date(o.createdAt));
      addDay(day);
      const d = days.get(day);
      d.orders++;
      if (o.status !== "cancelled") d.revenue += o.total;
    }
    for (const p of payments) {
      addDay(p.date);
      const d = days.get(p.date);
      d.payments++;
      if (p.status === "paid") d.paymentsTotal += p.amount;
    }
    for (const s of sessions) {
      addDay(s.date);
      if (!days.get(s.date).session) {
        days.get(s.date).session = { id: s.id, startedAt: s.startedAt, endedAt: s.endedAt };
      }
    }
    const list = [...days.values()]
      .map((d) => ({
        ...d,
        revenue: Math.round(d.revenue * 100) / 100,
        paymentsTotal: Math.round(d.paymentsTotal * 100) / 100,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
    res.json(list);
  } catch (e) {
    log.error({ err: e }, "failed to load workdays");
    res.status(500).json({ error: "Failed to load workday folders" });
  }
});

router.get("/:date", authenticateUser, requireStaff, async (req, res) => {
  const day = String(req.params.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: "Date must be YYYY-MM-DD." });
  }
  try {
    const start = new Date(`${day}T00:00:00`);
    const end = new Date(`${day}T23:59:59.999`);
    const [bookings, orders, payments, session, logs] = await Promise.all([
      prisma.booking.findMany({ where: { date: day }, orderBy: { time: "asc" } }),
      prisma.order.findMany({ where: { createdAt: { gte: start, lte: end } }, orderBy: { createdAt: "desc" } }),
      prisma.payment.findMany({ where: { date: day }, orderBy: { createdAt: "desc" } }),
      prisma.workSession.findFirst({ where: { date: day }, orderBy: { startedAt: "desc" } }),
      prisma.auditLog.findMany({ where: { createdAt: { gte: start, lte: end } }, orderBy: { createdAt: "desc" }, take: 300 }),
    ]);
    res.json({ date: day, session, bookings, orders, payments, logs });
  } catch (e) {
    log.error({ err: e }, "failed to load workday");
    res.status(500).json({ error: "Failed to load workday folder" });
  }
});

export default router;
