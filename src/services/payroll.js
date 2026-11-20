import { prisma } from "../lib/prisma.js";

export function calculateHours(startedAt, endedAt) {
  if (!startedAt || !endedAt) return 0;
  return (endedAt.getTime() - startedAt.getTime()) / (1000 * 60 * 60);
}

/**
 * Number of days in a month that yields the correct pro-rated salary when used
 * as `monthlySalary / effectiveDaysInMonth * daysInPeriod`. For a single-month
 * period this is just that month's length; for multi-month periods it is the
 * length-weighted mean, so each calendar month is pro-rated correctly.
 * Defaults to 30 for callers that do not supply a period.
 */
export function effectiveDaysInMonth(periodStart, periodEnd) {
  if (!periodStart || !periodEnd) return 30;
  const start = new Date(`${periodStart}T00:00:00Z`);
  const end = new Date(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 30;

  const daysInPeriod = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
  let fraction = 0;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0));
    const from = cursor < start ? start.getUTCDate() : 1;
    const to = lastDay <= end ? lastDay.getUTCDate() : end.getUTCDate();
    if (to >= from) fraction += (to - from + 1) / lastDay.getUTCDate();
    cursor.setUTCMonth(month + 1);
  }
  return fraction > 0 ? daysInPeriod / fraction : 30;
}

export function calculateBasePay(employee, hours, daysInPeriod, daysInMonth = 30) {
  if (employee.payRateType === "monthly") {
    return (employee.monthlySalary / daysInMonth) * daysInPeriod;
  }
  return hours * employee.hourlyRate;
}

/** Base pay for a single session when no record-level total is supplied. */
export function sessionBasePay(employee, hours, daysInMonth = 30) {
  if (employee.payRateType === "monthly") {
    const dailyRate = employee.monthlySalary / daysInMonth;
    const hoursPerDay = Number(employee.roleHoursPerDay) > 0 ? Number(employee.roleHoursPerDay) : 8;
    return dailyRate * Math.min(hours / hoursPerDay, 1);
  }
  return hours * employee.hourlyRate;
}

const now = () => new Date();

/**
 * Effective commission rate (percent) for an employee.
 *
 * `Employee.commissionRates` is a per-service-category map like
 * `{"spay-neuter": 10, "dental": 8}` (percent of revenue). Orders are not
 * categorized in the payroll pipeline, so we apply the mean of all configured
 * rates to attributed revenue. An empty map means no commission.
 */
export function effectiveCommissionRate(employee) {
  const rates = employee?.commissionRates;
  if (!rates || typeof rates !== "object") return 0;
  const values = Object.values(rates).filter(
    (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function commissionForEmployee(employee, revenue) {
  const rate = effectiveCommissionRate(employee);
  if (rate <= 0) return 0;
  return (revenue * rate) / 100;
}

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

export function calculateBreakdown(sessions, employee, options = {}) {
  const daysInMonth = options.daysInMonth ?? 30;
  const totalHours = sessions.reduce(
    (sum, session) => sum + calculateHours(session.startedAt, session.endedAt),
    0,
  );
  return sessions.map((session) => {
    const hours = calculateHours(session.startedAt, session.endedAt);
    // When the record's already-computed base pay is provided, distribute it
    // across sessions by hours so the breakdown always reconciles with the
    // record total — including for monthly-paid employees.
    const basePay =
      options.basePay !== undefined && totalHours > 0
        ? options.basePay * (hours / totalHours)
        : sessionBasePay(employee, hours, daysInMonth);
    return {
      sessionId: session.id,
      date: session.date,
      hours,
      bookings: session.bookingsCount,
      orders: session.ordersCount,
      revenue: session.revenueTotal,
      basePay: parseFloat(basePay.toFixed(2)),
      commission: commissionForEmployee(employee, session.revenueTotal),
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
      roleHoursPerDay: true,
      commissionRates: true,
    },
  });

  const sessions = await prisma.workSession.findMany({
    where: { date: { gte: periodStart, lte: periodEnd } },
    orderBy: { startedAt: "asc" },
  });

  const daysInPeriod = (new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60 * 24) + 1;
  const daysInMonth = effectiveDaysInMonth(periodStart, periodEnd);

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
    const basePay = calculateBasePay(employee, totals.hours, daysInPeriod, daysInMonth);
    const commissionPay = commissionForEmployee(employee, totals.revenue);
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
      breakdown: calculateBreakdown(empSessions, employee, { daysInMonth, basePay }),
    });
  }

  return records;
}
