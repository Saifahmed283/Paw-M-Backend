import { describe, it, expect } from "vitest";
import {
  calculateHours,
  calculateBasePay,
  calculateSessionTotals,
  calculateBreakdown,
  effectiveCommissionRate,
  commissionForEmployee,
  effectiveDaysInMonth,
  sessionBasePay,
} from "../../src/services/payroll.js";

describe("payroll service", () => {
  describe("calculateHours", () => {
    it("returns 0 for missing dates", () => {
      expect(calculateHours(null, null)).toBe(0);
      expect(calculateHours(new Date(), null)).toBe(0);
      expect(calculateHours(null, new Date())).toBe(0);
    });

    it("calculates hours between two dates", () => {
      const start = new Date("2026-01-01T09:00:00");
      const end = new Date("2026-01-01T17:00:00");
      expect(calculateHours(start, end)).toBe(8);
    });

    it("handles fractional hours", () => {
      const start = new Date("2026-01-01T09:00:00");
      const end = new Date("2026-01-01T12:30:00");
      expect(calculateHours(start, end)).toBe(3.5);
    });
  });

  describe("calculateBasePay", () => {
    it("calculates hourly pay", () => {
      const employee = { payRateType: "hourly", hourlyRate: 50, monthlySalary: 0 };
      expect(calculateBasePay(employee, 8, 1)).toBe(400);
    });

    it("calculates monthly pay pro-rated for period", () => {
      const employee = { payRateType: "monthly", hourlyRate: 0, monthlySalary: 3000 };
      expect(calculateBasePay(employee, 0, 15)).toBe(1500);
    });

    it("calculates monthly pay for single day", () => {
      const employee = { payRateType: "monthly", hourlyRate: 0, monthlySalary: 3000 };
      expect(calculateBasePay(employee, 0, 1)).toBe(100);
    });

    it("uses the real month length instead of a hardcoded 30 days", () => {
      const employee = { payRateType: "monthly", hourlyRate: 0, monthlySalary: 3100 };
      // January has 31 days, so a full month must pay exactly the salary.
      expect(calculateBasePay(employee, 0, 31, 31)).toBe(3100);
      // February has 28 days.
      expect(calculateBasePay(employee, 0, 28, 28)).toBe(3100);
    });
  });

  describe("effectiveDaysInMonth", () => {
    it("returns the actual length of a single-month period", () => {
      expect(effectiveDaysInMonth("2026-01-01", "2026-01-31")).toBe(31);
      expect(effectiveDaysInMonth("2026-02-01", "2026-02-28")).toBe(28);
    });

    it("weights each month correctly for multi-month periods", () => {
      // Jan 17-31 = 15/31 of a month, Feb 1-14 = 14/28 = 1/2.
      const days = effectiveDaysInMonth("2026-01-17", "2026-02-14");
      const expected = 3100 * (15 / 31 + 14 / 28);
      expect(calculateBasePay({ payRateType: "monthly", monthlySalary: 3100 }, 0, 29, days)).toBeCloseTo(expected, 2);
    });

    it("falls back to 30 for missing or inverted ranges", () => {
      expect(effectiveDaysInMonth(null, null)).toBe(30);
      expect(effectiveDaysInMonth("2026-02-01", "2026-01-01")).toBe(30);
    });
  });

  describe("monthly session pay", () => {
    it("uses roleHoursPerDay for a single session's pro-rated daily pay", () => {
      const employee = {
        payRateType: "monthly",
        monthlySalary: 2400,
        roleHoursPerDay: 6,
      };
      // 30-day month => 80/day; 3 of 6 hours => 40.
      expect(sessionBasePay(employee, 3, 30)).toBe(40);
      // Overtime is capped at one daily rate.
      expect(sessionBasePay(employee, 9, 30)).toBe(80);
    });
  });

  describe("commission helpers", () => {
    it("returns 0 for empty or missing commission rates", () => {
      expect(effectiveCommissionRate({})).toBe(0);
      expect(effectiveCommissionRate({ commissionRates: {} })).toBe(0);
      expect(effectiveCommissionRate(null)).toBe(0);
    });

    it("averages configured per-category rates", () => {
      const employee = { commissionRates: { "spay-neuter": 10, dental: 8, grooming: 12 } };
      expect(effectiveCommissionRate(employee)).toBe(10);
      expect(commissionForEmployee(employee, 1000)).toBe(100);
    });

    it("ignores invalid or non-positive rates", () => {
      const employee = { commissionRates: { a: 0, b: -5, c: "x" } };
      expect(effectiveCommissionRate(employee)).toBe(0);
      expect(commissionForEmployee(employee, 500)).toBe(0);
    });
  });

  describe("calculateSessionTotals", () => {
    it("returns zeros for empty sessions", () => {
      const totals = calculateSessionTotals([]);
      expect(totals).toEqual({
        sessions: 0, hours: 0, bookings: 0, orders: 0, revenue: 0, commission: 0,
      });
    });

    it("aggregates multiple sessions", () => {
      const sessions = [
        {
          startedAt: new Date("2026-01-01T09:00:00"),
          endedAt: new Date("2026-01-01T17:00:00"),
          bookingsCount: 5,
          ordersCount: 3,
          revenueTotal: 500,
          commissionTotal: 50,
        },
        {
          startedAt: new Date("2026-01-02T09:00:00"),
          endedAt: new Date("2026-01-02T13:00:00"),
          bookingsCount: 2,
          ordersCount: 1,
          revenueTotal: 200,
          commissionTotal: 20,
        },
      ];
      const totals = calculateSessionTotals(sessions);
      expect(totals.sessions).toBe(2);
      expect(totals.hours).toBe(12);
      expect(totals.bookings).toBe(7);
      expect(totals.orders).toBe(4);
      expect(totals.revenue).toBe(700);
      expect(totals.commission).toBe(70);
    });
  });

  describe("calculateBreakdown", () => {
    it("maps sessions with base pay calculation", () => {
      const sessions = [
        {
          id: "ws-1",
          date: "2026-01-01",
          startedAt: new Date("2026-01-01T09:00:00"),
          endedAt: new Date("2026-01-01T17:00:00"),
          bookingsCount: 3,
          ordersCount: 2,
          revenueTotal: 300,
          commissionTotal: 30,
        },
      ];
      const employee = { hourlyRate: 50 };
      const breakdown = calculateBreakdown(sessions, employee);
      expect(breakdown).toHaveLength(1);
      expect(breakdown[0].hours).toBe(8);
      expect(breakdown[0].basePay).toBe(400);
      // commission derives from the employee's commissionRates (none here) — the
      // live counter is no longer trusted for payroll numbers
      expect(breakdown[0].commission).toBe(0);
    });

    it("distributes a supplied record base pay across sessions by hours", () => {
      const sessions = [
        {
          id: "ws-1",
          date: "2026-01-01",
          startedAt: new Date("2026-01-01T09:00:00"),
          endedAt: new Date("2026-01-01T17:00:00"),
          bookingsCount: 0,
          ordersCount: 0,
          revenueTotal: 0,
        },
        {
          id: "ws-2",
          date: "2026-01-02",
          startedAt: new Date("2026-01-02T09:00:00"),
          endedAt: new Date("2026-01-02T13:00:00"),
          bookingsCount: 0,
          ordersCount: 0,
          revenueTotal: 0,
        },
      ];
      const monthly = { payRateType: "monthly", monthlySalary: 3100, hourlyRate: 0 };
      const breakdown = calculateBreakdown(sessions, monthly, { basePay: 3000 });
      expect(breakdown[0].basePay).toBe(2000);
      expect(breakdown[1].basePay).toBe(1000);
      expect(breakdown.reduce((sum, row) => sum + row.basePay, 0)).toBe(3000);
    });
  });
});
