import { prisma } from "../lib/prisma.js";
import {
  attributeOrderCounts,
  applyAttributedOrders,
  calculateBasePay,
  calculateSessionTotals,
} from "./payroll.js";

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute per-employee KPI for a period.
 *
 * Orders and revenue are derived from the real order table: every order is
 * attributed to the work session (and thus the employee) that was open at the
 * moment the order was created. This is self-healing — it no longer relies on
 * a live counter that was incremented only when a cashier happened to have an
 * open session at checkout time, and it excludes cancelled orders.
 *
 * @param {{ periodStart: string, periodEnd: string, employeeIds?: string[] }} opts
 * @returns {Promise<Array<object>>} KPI rows (one per active employee)
 */
export async function computeKpiOverview({ periodStart, periodEnd, employeeIds }) {
  const employees = await prisma.employee.findMany({
    where: {
      isActive: true,
      ...(employeeIds?.length ? { id: { in: employeeIds } } : {}),
    },
    select: {
      id: true,
      fullName: true,
      hourlyRate: true,
      monthlySalary: true,
      payRateType: true,
    },
  });

  const sessions = await prisma.workSession.findMany({
    where: { date: { gte: periodStart, lte: periodEnd } },
    select: {
      id: true,
      employeeId: true,
      startedAt: true,
      endedAt: true,
      bookingsCount: true,
      ordersCount: true,
      revenueTotal: true,
      commissionTotal: true,
    },
  });

  // Widen the order window by one day on each side so orders created near the
  // period boundary (in UTC vs local midnight) still match a session timestamp.
  const orders = await prisma.order.findMany({
    where: {
      status: { not: "cancelled" },
      archived: false,
      createdAt: {
        gte: new Date(`${shiftDate(periodStart, -1)}T00:00:00.000Z`),
        lte: new Date(`${shiftDate(periodEnd, 1)}T23:59:59.999Z`),
      },
    },
    select: { createdAt: true, total: true },
  });

  applyAttributedOrders(sessions, attributeOrderCounts(orders, sessions));

  const daysInPeriod = (new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60 * 24) + 1;
  const sessionsByEmployee = new Map();
  for (const session of sessions) {
    const list = sessionsByEmployee.get(session.employeeId) ?? [];
    list.push(session);
    sessionsByEmployee.set(session.employeeId, list);
  }

  return employees.map((employee) => {
    const totals = calculateSessionTotals(sessionsByEmployee.get(employee.id) ?? []);
    const basePay = calculateBasePay(employee, totals.hours, daysInPeriod);
    return {
      employeeId: employee.id,
      employeeName: employee.fullName,
      ...totals,
      basePay: parseFloat(basePay.toFixed(2)),
      grossPay: parseFloat((totals.commission + basePay).toFixed(2)),
    };
  });
}