import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { todayStr } from "../lib/utils.js";
import { clinicDayRange, expectedForDate, round2 } from "../lib/clinic-day.js";
import { employeeNameMap, mapCashWithdrawal } from "../lib/cash-withdrawal.js";
import { logger } from "../lib/logger.js";
import { calculateHours } from "../services/payroll.js";
import { resolveEmployeeId } from "../lib/resolve-employee.js";
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

function sessionEnd(session, sessions) {
  if (session.endedAt) return new Date(session.endedAt);
  const next = sessions
    .filter(
      (s) =>
        s.employeeId === session.employeeId &&
        s.id !== session.id &&
        new Date(s.startedAt) > new Date(session.startedAt),
    )
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))[0];
  return next ? new Date(next.startedAt) : new Date();
}

function inSession(value, session, sessions) {
  if (!value) return false;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return false;
  return time >= new Date(session.startedAt) && time <= sessionEnd(session, sessions);
}

/** One record belongs to the most recently started shift that contains it. */
function pickSession(value, sessions) {
  return sessions
    .filter((session) => inSession(value, session, sessions))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0] ?? null;
}

function staffIdFromLog(log, sessions, adminUsers) {
  const byStaff = /by staff #(\d+)/.exec(String(log.detail ?? ""));
  if (byStaff) {
    const account = adminUsers.find((user) => user.id === Number(byStaff[1]));
    if (account?.employeeId) return account.employeeId;
  }
  const targetSession = sessions.find((session) => session.id === log.target);
  if (targetSession?.employeeId) return targetSession.employeeId;
  return null;
}

function attributeDay({ logs, orders, payments, sessions, adminUsers }) {
  const usernameToEmployee = new Map(
    adminUsers.filter((user) => user.employeeId).map((user) => [user.username, user.employeeId]),
  );
  const logAttribution = new Map();
  for (const entry of logs) {
    const employeeId =
      staffIdFromLog(entry, sessions, adminUsers) ?? pickSession(entry.createdAt, sessions)?.employeeId;
    if (employeeId) logAttribution.set(entry.id, employeeId);
  }
  const orderAttribution = new Map();
  for (const order of orders) {
    const employeeId = pickSession(order.createdAt, sessions)?.employeeId;
    if (employeeId) orderAttribution.set(order.id, employeeId);
  }
  const paymentAttribution = new Map();
  for (const payment of payments) {
    const employeeId =
      usernameToEmployee.get(payment.requestedBy) ??
      pickSession(payment.createdAt, sessions)?.employeeId;
    if (employeeId) paymentAttribution.set(payment.id, employeeId);
  }
  return { logAttribution, orderAttribution, paymentAttribution };
}

/** Repeated identical actions become one row with a count, not a long log. */
function summarizeLogs(logs) {
  const groups = new Map();
  for (const entry of logs) {
    const key = `${entry.action}|${entry.target}|${entry.detail}`;
    const existing = groups.get(key);
    const time = new Date(entry.createdAt).getTime();
    if (existing) {
      existing.count += 1;
      if (time > new Date(existing.createdAt).getTime()) existing.createdAt = entry.createdAt;
    } else {
      groups.set(key, {
        id: entry.id,
        action: entry.action,
        target: entry.target,
        detail: entry.detail,
        count: 1,
        createdAt: entry.createdAt,
      });
    }
  }
  return [...groups.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

function buildStaffGroups({ sessions, orders, payments, logs, employees, attribution }) {
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const groups = new Map();

  const groupFor = (employeeId, fallback) => {
    const key = employeeId ?? `session:${fallback?.id ?? "unknown"}`;
    if (!groups.has(key)) {
      const employee = employeeById.get(key);
      groups.set(key, {
        id: key,
        employee: employee
          ? { id: employee.id, fullName: employee.fullName, role: employee.role, email: employee.email }
          : { id: key, fullName: "Unassigned", role: "staff", email: "" },
        sessions: [],
        hours: 0,
        ordersCount: 0,
        revenue: 0,
        cashCollected: 0,
        activityCount: 0,
        logs: [],
        shiftCount: 0,
        firstCheckIn: null,
        lastCheckOut: null,
      });
    }
    return groups.get(key);
  };

  for (const session of sessions) {
    groupFor(session.employeeId, session).sessions.push(session);
  }

  const result = [];
  for (const [employeeId, group] of groups) {
    const shifts = group.sessions.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
    group.shiftCount = shifts.length;
    group.hours = round2(
      shifts.reduce(
        (total, session) =>
          total + calculateHours(new Date(session.startedAt), sessionEnd(session, shifts)),
        0,
      ),
    );
    group.firstCheckIn = shifts[0]?.startedAt ?? null;
    const ended = shifts.map((session) => session.endedAt).filter(Boolean);
    group.lastCheckOut = ended.length
      ? ended.sort((a, b) => new Date(b) - new Date(a))[0]
      : null;

    const ownOrders = orders.filter((order) => attribution.orderAttribution.get(order.id) === employeeId);
    group.ordersCount = ownOrders.length;
    group.revenue = sum(
      ownOrders.filter((order) => order.status !== "cancelled"),
      (order) => order.total,
    );

    const ownPayments = payments.filter(
      (payment) => attribution.paymentAttribution.get(payment.id) === employeeId,
    );
    group.cashCollected = sum(
      ownPayments.filter((payment) => payment.method === "cash" && payment.status === "paid"),
      (payment) => payment.amount,
    );

    group.logs = summarizeLogs(
      logs.filter((entry) => attribution.logAttribution.get(entry.id) === employeeId),
    );
    group.activityCount = group.logs.reduce((total, entry) => total + entry.count, 0);
    result.push(group);
  }

  return result.sort(
    (a, b) => new Date(b.firstCheckIn ?? 0).getTime() - new Date(a.firstCheckIn ?? 0).getTime(),
  );
}

function scopedIdsForEmployee({ orders, payments, sessions, employeeId, adminUsers }) {
  if (!employeeId) return { orderIds: new Set(), paymentIds: new Set(), ownSessions: [] };
  const usernameToEmployee = new Map(
    adminUsers.filter((user) => user.employeeId).map((user) => [user.username, user.employeeId]),
  );
  const ownSessions = sessions.filter((session) => session.employeeId === employeeId);
  const orderIds = new Set(
    orders
      .filter((order) => pickSession(order.createdAt, ownSessions)?.employeeId === employeeId)
      .map((order) => order.id),
  );
  const paymentIds = new Set(
    payments
      .filter(
        (payment) =>
          usernameToEmployee.get(payment.requestedBy) === employeeId ||
          pickSession(payment.createdAt, ownSessions)?.employeeId === employeeId,
      )
      .map((payment) => payment.id),
  );
  return { orderIds, paymentIds, ownSessions };
}

router.get("/", authenticateUser, requireStaff, async (req, res) => {
  try {
    const isFullAccess = req.user.role !== "staff";
    const employeeId = isFullAccess ? null : await resolveEmployeeId(req.user.id);
    const [bookings, allOrders, allPayments, allSessions, adminUsers] = await Promise.all([
      prisma.booking.findMany({ select: { id: true, date: true, status: true } }),
      prisma.order.findMany({ select: { id: true, createdAt: true, total: true, status: true } }),
      prisma.payment.findMany({ select: { id: true, date: true, amount: true, status: true, requestedBy: true, createdAt: true } }),
      prisma.workSession.findMany({
        select: { id: true, date: true, employeeId: true, startedAt: true, endedAt: true },
        orderBy: { startedAt: "desc" },
      }),
      prisma.adminUser.findMany({ select: { id: true, username: true, employeeId: true } }),
    ]);

    let orders = allOrders;
    let payments = allPayments;
    let sessions = allSessions;
    if (!isFullAccess) {
      const scoped = scopedIdsForEmployee({
        orders: allOrders,
        payments: allPayments,
        sessions: allSessions,
        employeeId,
        adminUsers,
      });
      orders = allOrders.filter((order) => scoped.orderIds.has(order.id));
      payments = allPayments.filter((payment) => scoped.paymentIds.has(payment.id));
      sessions = scoped.ownSessions;
    }

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
    for (const booking of isFullAccess ? bookings : []) {
      addDay(booking.date);
      days.get(booking.date).bookings++;
    }
    for (const order of orders) {
      const day = todayStr(new Date(order.createdAt));
      addDay(day);
      const entry = days.get(day);
      entry.orders++;
      if (order.status !== "cancelled") entry.revenue += order.total;
    }
    for (const payment of payments) {
      addDay(payment.date);
      const entry = days.get(payment.date);
      entry.payments++;
      if (payment.status === "paid") entry.paymentsTotal += payment.amount;
    }
    for (const session of sessions) {
      addDay(session.date);
      if (!days.get(session.date).session) {
        days.get(session.date).session = {
          id: session.id,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
        };
      }
    }
    const list = [...days.values()]
      .map((entry) => ({
        ...entry,
        revenue: round2(entry.revenue),
        paymentsTotal: round2(entry.paymentsTotal),
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
    res.json(list);
  } catch (err) {
    log.error({ err }, "failed to load workdays");
    res.status(500).json({ error: "Failed to load workday folders" });
  }
});

router.get("/:date", authenticateUser, requireStaff, async (req, res) => {
  const day = String(req.params.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: "Date must be YYYY-MM-DD." });
  }
  try {
    const isFullAccess = req.user.role !== "staff";
    const employeeId = isFullAccess ? null : await resolveEmployeeId(req.user.id);
    const { start, end } = clinicDayRange(day);
    const [
      allBookings,
      allOrders,
      allPayments,
      allSessions,
      allLogs,
      cashDrawer,
      allVerifications,
      expectedCash,
      adminUsers,
      employees,
      allWithdrawals,
    ] = await Promise.all([
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
      prisma.adminUser.findMany({ select: { id: true, username: true, employeeId: true } }),
      prisma.employee.findMany({
        select: { id: true, fullName: true, role: true, email: true },
      }),
      prisma.cashWithdrawal.findMany({
        where: { date: day },
        orderBy: { createdAt: "desc" },
        include: {
          requester: { select: { id: true, username: true } },
          reviewer: { select: { id: true, username: true } },
        },
      }),
    ]);

    const attribution = attributeDay({
      logs: allLogs,
      orders: allOrders,
      payments: allPayments,
      sessions: allSessions,
      adminUsers,
    });
    const staffGroups = buildStaffGroups({
      sessions: allSessions,
      orders: allOrders,
      payments: allPayments,
      logs: allLogs,
      employees,
      attribution,
    });

    let bookings = allBookings;
    let orders = allOrders;
    let payments = allPayments;
    let sessions = allSessions;
    let logs = allLogs;
    let verifications = allVerifications;
    let staff = staffGroups;
    let scopedCashDrawer = cashDrawer;
    if (!isFullAccess) {
      const scoped = scopedIdsForEmployee({
        orders: allOrders,
        payments: allPayments,
        sessions: allSessions,
        employeeId,
        adminUsers,
      });
      orders = allOrders.filter((order) => scoped.orderIds.has(order.id));
      payments = allPayments.filter((payment) => scoped.paymentIds.has(payment.id));
      sessions = scoped.ownSessions;
      logs = allLogs.filter((entry) => attribution.logAttribution.get(entry.id) === employeeId);
      verifications = [];
      staff = staffGroups.filter((group) => group.id === employeeId);
      // A cashier's view never includes the shared till reconciliation.
      scopedCashDrawer = null;
      bookings = [];
    }

    const finance = buildFinance({
      orders,
      payments,
      verifications,
      cashDrawer: scopedCashDrawer,
      sessions,
      expectedCash: isFullAccess ? expectedCash : 0,
    });
    const names = employeeNameMap(employees);
    const withdrawals = allWithdrawals
      .filter((row) => isFullAccess || row.requestedBy === req.user.id)
      .map((row) => mapCashWithdrawal(row, names));

    res.json({
      date: day,
      view: isFullAccess ? "admin" : "staff",
      scopeEmployeeId: employeeId,
      session: sessions.at(-1) ?? null,
      sessions,
      staff,
      bookings,
      orders,
      payments,
      logs,
      finance,
      withdrawals,
    });
  } catch (err) {
    log.error({ err }, "failed to load workday");
    res.status(500).json({ error: "Failed to load workday folder" });
  }
});

export default router;
