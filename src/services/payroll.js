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

  const daysInPeriod = (new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60 * 24) + 1;
  const records = [];

  for (const employee of employees) {
    const sessions = await prisma.workSession.findMany({
      where: {
        employeeId: employee.id,
        date: { gte: periodStart, lte: periodEnd },
      },
      orderBy: { startedAt: "asc" },
    });

    if (sessions.length === 0) continue;

    const totals = calculateSessionTotals(sessions);
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
      breakdown: calculateBreakdown(sessions, employee),
    });
  }

  return records;
}
