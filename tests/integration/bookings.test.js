import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: mockPrisma,
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  authenticateUser: (req, _res, next) => {
    req.user = { id: 1, username: "admin", role: "admin" };
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
  requirePayrollOrAdmin: (_req, _res, next) => next(),
}));

import productRouter from "../../src/routes/products.js";

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

describe("Product import API", () => {
  const existingProduct = {
    id: "product-1",
    name: "Cat Food",
    description: "Adult",
    price: 15,
    compareAtPrice: null,
    image: "existing.jpg",
    category: "food",
    petType: "cat",
    stock: 4,
    featured: true,
    barcode: "CAT-001",
    barcodeImage: "existing-barcode.jpg",
  };
  const duplicateProduct = {
    name: "Updated Cat Food",
    description: "New formula",
    price: 18,
    category: "food",
    petType: "cat",
    stock: 8,
    barcode: "CAT-001",
  };
  const newProduct = {
    name: "Rope Toy",
    description: "500 g",
    price: 9,
    category: "toys",
    petType: "both",
    stock: 3,
    barcode: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.product.findMany.mockResolvedValue([existingProduct]);
    mockPrisma.product.create.mockImplementation(({ data }) =>
      Promise.resolve({ ...data, id: "product-2", createdAt: new Date(), updatedAt: new Date() }),
    );
    mockPrisma.product.update.mockImplementation(({ where, data }) =>
      Promise.resolve({ ...existingProduct, ...where, ...data }),
    );
  });

  async function requestImport(duplicateAction, resolutions) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use("/api/products", productRouter);
    return request(testApp)
      .post("/api/products/import")
      .send({ products: [duplicateProduct, newProduct], duplicateAction, resolutions });
  }

  it("adds new products and skips duplicates without deleting the catalog", async () => {
    const response = await requestImport("skip");

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ created: 1, updated: 0, skipped: 1 });
    expect(response.body.results).toEqual([
      { index: 0, action: "skipped" },
      { index: 1, action: "created" },
    ]);
    expect(mockPrisma.product.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.product.create).toHaveBeenCalledWith({ data: expect.any(Object) });
    expect(mockPrisma.product.update).not.toHaveBeenCalled();
    expect(mockPrisma.product.delete).not.toHaveBeenCalled();
  });

  it("updates only the matched duplicate and preserves unrelated product fields", async () => {
    const response = await requestImport("replace");

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ created: 1, updated: 1, skipped: 0 });
    expect(response.body.results).toEqual([
      { index: 0, action: "updated" },
      { index: 1, action: "created" },
    ]);
    expect(mockPrisma.product.update).toHaveBeenCalledWith({
      where: { id: existingProduct.id },
      data: {
        name: duplicateProduct.name,
        description: duplicateProduct.description,
        price: duplicateProduct.price,
        category: duplicateProduct.category,
        petType: duplicateProduct.petType,
        stock: duplicateProduct.stock,
        barcode: duplicateProduct.barcode,
      },
    });
    expect(mockPrisma.product.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.product.delete).not.toHaveBeenCalled();
  });

  it("applies per-row resolutions instead of the blanket duplicate action", async () => {
    const response = await requestImport("skip", ["replace", "skip"]);

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ created: 1, updated: 1, skipped: 0 });
    expect(response.body.results).toEqual([
      { index: 0, action: "updated" },
      { index: 1, action: "created" },
    ]);
    expect(mockPrisma.product.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.product.create).toHaveBeenCalledTimes(1);
  });

  it("skips a duplicate row even when the blanket action is replace", async () => {
    const response = await requestImport("replace", ["skip", "skip"]);

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ created: 1, updated: 0, skipped: 1 });
    expect(mockPrisma.product.update).not.toHaveBeenCalled();
    expect(mockPrisma.product.create).toHaveBeenCalledTimes(1);
  });

  it("falls back to the blanket action for rows without a resolution", async () => {
    const response = await requestImport("replace", ["skip"]);

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({ created: 1, updated: 0, skipped: 1 });
    expect(mockPrisma.product.update).not.toHaveBeenCalled();
    expect(mockPrisma.product.create).toHaveBeenCalledTimes(1);
  });
});
