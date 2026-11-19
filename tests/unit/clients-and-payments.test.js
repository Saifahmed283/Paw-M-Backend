import { describe, it, expect } from "vitest";
import {
  createPaymentSchema,
  addPaymentItemsSchema,
  settlePaymentSchema,
  updatePaymentSchema,
} from "../../src/schemas/payments.js";
import { classifyClient } from "../../src/routes/clients.js";

describe("Payment visit-request schemas", () => {
  it("accepts a visit payment request with items", () => {
    const result = createPaymentSchema.safeParse({
      body: {
        title: "Consultation for Bella",
        bookingId: "bk-1",
        clientId: "cl-1",
        kind: "visit",
        requestedBy: "Dr. Mirna",
        date: "2026-09-23",
        items: [
          { label: "General check-up", amount: 300, kind: "service" },
          { label: "Dental scaling", amount: 900, kind: "service" },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body.kind).toBe("visit");
      expect(result.data.body.items).toHaveLength(2);
    }
  });

  it("rejects visit request with negative item amount", () => {
    const result = createPaymentSchema.safeParse({
      body: {
        title: "Consultation",
        kind: "visit",
        date: "2026-09-23",
        items: [{ label: "Check-up", amount: -5, kind: "service" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts proof_submitted as a payment status on create and update", () => {
    expect(
      createPaymentSchema.safeParse({
        body: { title: "InstaPay transfer", amount: 100, status: "proof_submitted" },
      }).success
    ).toBe(true);
    expect(
      updatePaymentSchema.safeParse({
        params: { id: "pay-1" },
        body: { status: "proof_submitted" },
      }).success
    ).toBe(true);
  });

  it("accepts a negative discount (other) line item", () => {
    const result = createPaymentSchema.safeParse({
      body: {
        title: "Order with discount",
        items: [
          { label: "Food", amount: 200, kind: "product" },
          { label: "Discount", amount: -50, kind: "other" },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts the legacy manual payment payload", () => {
    const result = createPaymentSchema.safeParse({
      body: {
        title: "Store order",
        amount: 120.5,
        method: "cash",
        status: "paid",
        date: "2026-09-23",
        orderId: "ord-1",
      },
    });
    expect(result.success).toBe(true);
  });

  it("validates add-items and settle payloads", () => {
    expect(
      addPaymentItemsSchema.safeParse({
        params: { id: "pay-1" },
        body: { items: [{ label: "Food", amount: 25, kind: "product", referenceId: "prod-1" }] },
      }).success
    ).toBe(true);
    expect(
      settlePaymentSchema.safeParse({ params: { id: "pay-1" }, body: { method: "fawry" } }).success
    ).toBe(true);
    expect(
      updatePaymentSchema.safeParse({
        params: { id: "pay-1" },
        body: { status: "paid", clientId: "cl-1", kind: "visit" },
      }).success
    ).toBe(true);
  });
});

describe("Client classification", () => {
  it("classifies clinic-only, store-only, both and new clients", () => {
    expect(classifyClient(1, 0)).toBe("clinic");
    expect(classifyClient(0, 2)).toBe("store");
    expect(classifyClient(3, 1)).toBe("both");
    expect(classifyClient(0, 0)).toBe("new");
  });
});