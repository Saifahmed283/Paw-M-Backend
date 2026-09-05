import { prisma } from "../lib/prisma.js";

export function calculateHours(startedAt, endedAt) {
  if (!startedAt || !endedAt) return 0;
  return (endedAt.getTime() - startedAt.getTime()) / (1000 * 60 * 60);
}

export function calculateBasePay(employee, hours, daysInPeriod) {
  if (employee.payRateType === "monthly") {
    return (employee.monthlySalary / 30) * daysInPeriod;
  }
  return hours * employee.hourlyRate;
}

const now = () => new Date();

/**
 * Attribute each order to the work session that was active when the order was
 * created (startedAt <= createdAt <= endedAt ?? now). Sessions that started
 * later win, so an order is attributed to exactly one session and therefore
 * one employee — even when two employees' shifts overlap.
 *
 * Orders placed outside any session window are left unattributed (they are
 * not tied to a cashier and stay clinic-level revenue in the workdays view).
 *
 * @param {Array<{createdAt: Date, total: number}>} orders
 * @param {Array<{id: string, startedAt: Date, endedAt: Date|null}>} sessions
 * @returns {Map<string, {orders: number, revenue: number}>} keyed by session id
 */
export function attributeOrderCounts(orders, sessions) {
  const sorted = [...sessions].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  const result = new Map();
  for (const order of orders) {
    const at = new Date(order.createdAt).getTime();
    const match = sorted.find((s) => {
      const start = new Date(s.startedAt).getTime();
      const end = s.endedAt ? new Date(s.endedAt).getTime() : now().getTime();
      return at >= start && at <= end;
    });
    if (!match) continue;
    const cur = result.get(match.id) ?? { orders: 0, revenue: 0 };
    cur.orders += 1;
    cur.revenue += order.total ?? 0;
    result.set(match.id, cur);
  }
  return result;
}

/**
 * Overwrite each matched session's orders/revenue counters with the derived
 * values so every downstream aggregate (session totals, breakdowns, payroll
 * records) reflects the actual orders instead of stale live counters.
 */
export function applyAttributedOrders(sessions, attributed) {
  for (const session of sessions) {
    const a = attributed.get(session.id);
    if (!a) continue;
    session.ordersCount = a.orders;
    session.revenueTotal = a.revenue;
  }
  return sessions;
}

export function calculateSessionTotals(sessions) {
  return sessions.reduce(
    (acc, session) => ({
      sessions: acc.sessions + 1,
      hours: acc.hours + calculateHours(session.startedAt, session.endedAt),
      bookings: acc.bookings + session.bookingsCount,
      orders: acc.orders + session.ordersCount,
      revenue: acc.revenue + session.revenueTotal,
      commission: acc.commission + session.commissionTotal,
    }),
    { sessions: 0, hours: 0, bookings: 0, orders: 0, revenue: 0, commission: 0 }
  );
}

export function calculateBreakdown(sessions, employee) {
  return sessions.map((session) => {
    const hours = calculateHours(session.startedAt, session.endedAt);
    return {
      sessionId: session.id,
      date: session.date,
      hours,
      bookings: session.bookingsCount,
      orders: session.ordersCount,
      revenue: session.revenueTotal,
      basePay: hours * employee.hourlyRate,
      commission: session.commissionTotal,
    };
  });
}

export async function calculatePayrollForPeriod(periodStart, periodEnd) {
  const employees = await prisma.employee.findMany({
    where: { isActive: true },
    select: {
      id: true,
      fullName: true,
      role: true,
      hourlyRate: true,
      monthlySalary: true,
      payRateType: true,
      commissionRates: true,
    },
  });

  const sessions = await prisma.workSession.findMany({
    where: { date: { gte: periodStart, lte: periodEnd } },
    orderBy: { startedAt: "asc" },
  });

  const daysInPeriod = (new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60 * 24) + 1;

  // Widen the order window by one day on each side so orders created near the
  // period boundary still match a session timestamp; window matching keeps them
  // attributed to the right session only.
  const shift = (d, n) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const orders = await prisma.order.findMany({
    where: {
      status: { not: "cancelled" },
      archived: false,
      createdAt: {
        gte: new Date(`${shift(periodStart, -1)}T00:00:00.000Z`),
        lte: new Date(`${shift(periodEnd, 1)}T23:59:59.999Z`),
      },
    },
    select: { createdAt: true, total: true },
  });

  applyAttributedOrders(sessions, attributeOrderCounts(orders, sessions));

  const sessionsByEmployee = new Map();
  for (const session of sessions) {
    const list = sessionsByEmployee.get(session.employeeId) ?? [];
    list.push(session);
    sessionsByEmployee.set(session.employeeId, list);
  }

  const records = [];

  for (const employee of employees) {
    const empSessions = sessionsByEmployee.get(employee.id) ?? [];
    if (empSessions.length === 0) continue;

    const totals = calculateSessionTotals(empSessions);
    const basePay = calculateBasePay(employee, totals.hours, daysInPeriod);
    const commissionPay = totals.commission;
    const netPay = basePay + commissionPay;

    records.push({
      employeeId: employee.id,
      periodStart,
      periodEnd,
      totalSessions: totals.sessions,
      totalHours: parseFloat(totals.hours.toFixed(2)),
      totalBookings: totals.bookings,
      totalOrders: totals.orders,
      totalRevenue: parseFloat(totals.revenue.toFixed(2)),
      basePay: parseFloat(basePay.toFixed(2)),
      commissionPay: parseFloat(commissionPay.toFixed(2)),
      totalBonuses: 0,
      totalDeductions: 0,
      netPay: parseFloat(netPay.toFixed(2)),
      status: "calculated",
      breakdown: calculateBreakdown(empSessions, employee),
    });
  }

  return records;
}
