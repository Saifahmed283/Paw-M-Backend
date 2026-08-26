import { describe, it, expect } from "vitest";
import {
  calculateHours,
  calculateBasePay,
  calculateSessionTotals,
  calculateBreakdown,
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
      expect(breakdown[0].commission).toBe(30);
    });
  });
});
