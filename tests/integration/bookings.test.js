import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: mockPrisma,
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

describe("Booking validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects booking with missing required fields", async () => {
    const { createBookingSchema } = await import("../../src/schemas/bookings.js");
    const result = createBookingSchema.safeParse({
      body: { ownerName: "" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid booking data", async () => {
    const { createBookingSchema } = await import("../../src/schemas/bookings.js");
    const result = createBookingSchema.safeParse({
      body: {
        ownerName: "John Doe",
        phone: "01234567890",
        email: "john@example.com",
        petName: "Buddy",
        animalType: "Dog",
        breed: "Golden Retriever",
        age: "3",
        weight: "30",
        symptoms: "Checkup",
        allergies: "None",
        medications: "None",
        doctorId: "dr-1",
        doctorName: "Dr. Mirna",
        date: "2026-01-15",
        time: "10:00",
        emergency: false,
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("Order validation", () => {
  it("rejects order with empty items", async () => {
    const { createOrderSchema } = await import("../../src/schemas/orders.js");
    const result = createOrderSchema.safeParse({
      body: {
        customerName: "Test",
        phone: "01234567890",
        items: [],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid order data", async () => {
    const { createOrderSchema } = await import("../../src/schemas/orders.js");
    const result = createOrderSchema.safeParse({
      body: {
        customerName: "Test User",
        phone: "01234567890",
        items: [{ id: "prod-1", qty: 2 }],
        paymentMethod: "cash",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid payment method", async () => {
    const { createOrderSchema } = await import("../../src/schemas/orders.js");
    const result = createOrderSchema.safeParse({
      body: {
        customerName: "Test",
        phone: "01234567890",
        items: [{ id: "prod-1", qty: 1 }],
        paymentMethod: "bitcoin",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("Employee validation", () => {
  it("rejects employee with missing fields", async () => {
    const { createEmployeeSchema } = await import("../../src/schemas/employees.js");
    const result = createEmployeeSchema.safeParse({
      body: { fullName: "Test" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid employee data", async () => {
    const { createEmployeeSchema } = await import("../../src/schemas/employees.js");
    const result = createEmployeeSchema.safeParse({
      body: {
        fullName: "Test Employee",
        email: "test@example.com",
        role: "staff",
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("Payroll validation", () => {
  it("rejects invalid date format", async () => {
    const { calculatePayrollSchema } = await import("../../src/schemas/payroll.js");
    const result = calculatePayrollSchema.safeParse({
      body: { periodStart: "01-01-2026", periodEnd: "01-31-2026" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid date format", async () => {
    const { calculatePayrollSchema } = await import("../../src/schemas/payroll.js");
    const result = calculatePayrollSchema.safeParse({
      body: { periodStart: "2026-01-01", periodEnd: "2026-01-31" },
    });
    expect(result.success).toBe(true);
  });
});

describe("Payment validation", () => {
  it("rejects payment with negative amount", async () => {
    const { createPaymentSchema } = await import("../../src/schemas/payments.js");
    const result = createPaymentSchema.safeParse({
      body: {
        title: "Test",
        amount: -100,
        date: "2026-01-01",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects payment with invalid date", async () => {
    const { createPaymentSchema } = await import("../../src/schemas/payments.js");
    const result = createPaymentSchema.safeParse({
      body: {
        title: "Test",
        amount: 100,
        date: "not-a-date",
      },
    });
    expect(result.success).toBe(false);
  });
});
