import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { todayStr } from "../lib/utils.js";
import { clinicDayRange, expectedForDate, round2 } from "../lib/clinic-day.js";
import { logger } from "../lib/logger.js";
import { calculateHours } from "../services/payroll.js";
import { authenticateUser, requireStaff } from "../middleware/auth.js";

const router = Router();
const log = logger.child({ module: "routes/work-days" });

const METHODS = ["cash", "fawry", "instapay"];

const sum = (items, pick) => round2(items.reduce((acc, item) => acc + pick(item), 0));

function buildFinance({ orders, payments, verifications, cashDrawer, sessions, expectedCash }) {
  const paid = payments.filter((p) => p.status === "paid" && p.amount > 0);
  const pending = payments.filter(
    (p) => p.status !== "paid" && p.status !== "rejected" && p.amount > 0,
  );
  const refunded = payments.filter((p) => p.kind === "refund" && p.status === "paid");

  const byMethod = METHODS.map((method) => {
    const methodPaid = paid.filter((p) => p.method === method);
    const methodPending = pending.filter((p) => p.method === method);
    const methodRefunded = refunded.filter((p) => p.method === method);
    const collected = sum(methodPaid, (p) => p.amount);
    const refundTotal = sum(methodRefunded, (p) => Math.abs(p.amount));
    return {
      method,
      collected,
      pending: sum(methodPending, (p) => p.amount),
      refunded: refundTotal,
      net: round2(collected - refundTotal),
    };
  });

  const byKind = ["order", "visit", "manual", "refund"]
    .map((kind) => {
      const rows = payments.filter((p) => p.kind === kind);
      return {
        kind,
        count: rows.length,
        collected: sum(
          rows.filter((p) => p.status === "paid" && p.amount > 0),
          (p) => p.amount,
        ),
      };
    })
    .filter((row) => row.count > 0);

  const itemMap = new Map();
  for (const payment of payments) {
    for (const item of payment.items ?? []) {
      const key = `${item.kind}:${item.label}`;
      const current = itemMap.get(key) ?? {
        kind: item.kind,
        label: item.label,
        count: 0,
        amount: 0,
      };
      current.count += 1;
      current.amount += item.amount;
      itemMap.set(key, current);
    }
  }

  return {
    byMethod,
    byKind,
    items: [...itemMap.values()].map((item) => ({ ...item, amount: round2(item.amount) })),
    totals: {
      sales: sum(paid, (p) => p.amount),
      orders: sum(
        orders.filter((o) => o.status !== "cancelled"),
        (o) => o.total,
      ),
      products: sum(
        [...itemMap.values()].filter((item) => item.kind === "product"),
        (item) => item.amount,
      ),
      payments: sum(payments, (p) => p.amount),
      pending: sum(pending, (p) => p.amount),
      refunded: sum(refunded, (p) => Math.abs(p.amount)),
    },
    counts: {
      payments: payments.length,
      paidPayments: paid.length,
      orders: orders.length,
      verifications: verifications.length,
    },
    cashDrawer: cashDrawer
      ? {
          expected: cashDrawer.expected,
          counted: cashDrawer.counted,
          variance: cashDrawer.variance,
          note: cashDrawer.note,
          countedBy: cashDrawer.countedByUser?.fullName ?? String(cashDrawer.countedBy),
        }
      : { expected: expectedCash, counted: null, variance: null, note: "", countedBy: null },
    openingAmount: round2(
      sessions.reduce((acc, s) => acc + (s.custody?.openingAmount ?? 0), 0),
    ),
  };
}

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
        days.set(day, {
          date: day,
          bookings: 0,
          orders: 0,
          payments: 0,
          revenue: 0,
          paymentsTotal: 0,
          session: null,
        });
      }
    };
    for (const b of bookings) {
      addDay(b.date);
      days.get(b.date).bookings++;
    }
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
        revenue: round2(d.revenue),
        paymentsTotal: round2(d.paymentsTotal),
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
    const { start, end } = clinicDayRange(day);
    const [bookings, orders, payments, sessions, logs, cashDrawer, verifications, expectedCash] =
      await Promise.all([
        prisma.booking.findMany({ where: { date: day }, orderBy: { time: "asc" } }),
        prisma.order.findMany({
          where: { createdAt: { gte: start, lt: end } },
          orderBy: { createdAt: "desc" },
        }),
        prisma.payment.findMany({
          where: { date: day },
          orderBy: { createdAt: "desc" },
          include: { items: true },
        }),
        prisma.workSession.findMany({
          where: { date: day },
          orderBy: { startedAt: "asc" },
          include: {
            employee: { select: { id: true, fullName: true, role: true, email: true } },
            custody: true,
          },
        }),
        prisma.auditLog.findMany({
          where: { createdAt: { gte: start, lt: end } },
          orderBy: { createdAt: "desc" },
        }),
        prisma.cashDrawerClose.findFirst({
          where: { date: day },
          orderBy: { createdAt: "desc" },
          include: { countedByUser: { select: { id: true, username: true } } },
        }),
        prisma.paymentVerification.findMany({
          where: { createdAt: { gte: start, lt: end } },
          select: { id: true, decision: true, method: true, amount: true, source: true },
        }),
        expectedForDate(prisma, day),
      ]);

    // AuditLog has no actor column, so a session's time window is the most
    // reliable attribution available without changing the schema. Each log
    // belongs to exactly one non-overlapping shift in the day.
    const staff = sessions.map((session, index) => {
      const through = session.endedAt ?? sessions[index + 1]?.startedAt ?? new Date();
      const inShift = (value) => {
        const time = value instanceof Date ? value : new Date(value);
        return time >= session.startedAt && time <= through;
      };
      const shiftOrders = orders.filter((o) => inShift(o.createdAt));
      const shiftLogs = logs.filter((l) => inShift(l.createdAt));
      return {
        ...session,
        endedAt: session.endedAt ?? null,
        hours: round2(calculateHours(session.startedAt, session.endedAt ?? through)),
        ordersCount: shiftOrders.length,
        revenue: sum(
          shiftOrders.filter((o) => o.status !== "cancelled"),
          (o) => o.total,
        ),
        activityCount: shiftLogs.length,
        logs: shiftLogs,
      };
    });

    const finance = buildFinance({
      orders,
      payments,
      verifications,
      cashDrawer,
      sessions,
      expectedCash,
    });

    res.json({
      date: day,
      session: staff.at(-1) ?? null,
      sessions: staff,
      staff,
      bookings,
      orders,
      payments,
      logs,
      finance,
    });
  } catch (e) {
    log.error({ err: e }, "failed to load workday");
    res.status(500).json({ error: "Failed to load workday folder" });
  }
});

export default router;
