import { describe, it, expect } from "vitest";
import { computeRefundPlan } from "../../src/services/orders.js";
import { refundOrderSchema } from "../../src/schemas/orders.js";

const order = {
  id: "ORD-REFUND-1",
  items: [
    { id: "prod-1", name: "Dog Food", price: 200, qty: 2, image: "" },
    { id: "service-general-checkup", name: "General check-up", price: 300, qty: 1, image: "" },
  ],
  discountAmount: 70, // 10% of the 700 subtotal
  paymentMethod: "cash",
  paymentStatus: "paid", // POS cash sales are settled on the spot — still refundable
};

describe("computeRefundPlan", () => {
  it("plans a full refund of every remaining line", () => {
    const plan = computeRefundPlan(order, [], undefined);

    expect(plan.refundedLines).toEqual([
      { id: "prod-1", name: "Dog Food", qty: 2, amount: 400, kind: "product" },
      { id: "service-general-checkup", name: "General check-up", qty: 1, amount: 300, kind: "service" },
    ]);
    expect(plan.refundedAmount).toBe(630); // 700 - 70 discount share
    expect(plan.remainingRefundable).toBe(0);
    expect(plan.fullyRefunded).toBe(true);
  });

  it("plans a partial refund with a proportional discount share", () => {
    const plan = computeRefundPlan(order, [], [{ id: "prod-1", qty: 1 }]);

    expect(plan.refundedLines).toHaveLength(1);
    expect(plan.refundedLines[0]).toMatchObject({ id: "prod-1", qty: 1, amount: 200, kind: "product" });
    expect(plan.refundedAmount).toBe(180); // 200 - (70 * 200 / 700)
    expect(plan.remainingRefundable).toBe(450); // 500 - (70 * 500 / 700)
    expect(plan.fullyRefunded).toBe(false);
  });

  it("rejects over-refunds and lines that are not on the order", () => {
    expect(() => computeRefundPlan(order, [], [{ id: "prod-1", qty: 3 }]))
      .toThrowError(expect.objectContaining({ status: 400, message: expect.stringContaining("only 2 left") }));
    expect(() => computeRefundPlan(order, [], [{ id: "prod-missing", qty: 1 }]))
      .toThrowError(expect.objectContaining({ status: 400, message: expect.stringContaining("not on this order") }));
  });

  it("accounts for quantities already refunded by PaymentItem labels", () => {
    const payments = [
      // Non-refund payments must not reduce refundable quantities.
      { kind: "order", items: [{ label: "2x Dog Food", referenceId: "prod-1" }] },
      {
        kind: "refund",
        items: [
          { label: "1x Dog Food", referenceId: "prod-1", amount: -200 },
          { label: "1x General check-up", referenceId: "service-general-checkup", amount: -300 },
        ],
      },
    ];

    const plan = computeRefundPlan(order, payments, []);
    expect(plan.refundedLines).toHaveLength(1);
    expect(plan.refundedLines[0]).toMatchObject({ id: "prod-1", qty: 1, amount: 200 });
    expect(plan.refundedAmount).toBe(180);
    expect(plan.remainingRefundable).toBe(0);
    expect(plan.fullyRefunded).toBe(true);

    // The already-refunded service line cannot be refunded again.
    expect(() => computeRefundPlan(order, payments, [{ id: "service-general-checkup", qty: 1 }]))
      .toThrowError(expect.objectContaining({ status: 400 }));

    const exhausted = [
      {
        kind: "refund",
        items: [
          { label: "2x Dog Food", referenceId: "prod-1" },
          { label: "1x General check-up", referenceId: "service-general-checkup" },
        ],
      },
    ];
    expect(() => computeRefundPlan(order, exhausted, []))
      .toThrowError(expect.objectContaining({ status: 409, message: expect.stringContaining("Nothing left") }));
  });
});

describe("refundOrderSchema", () => {
  it("defaults reason and items so an empty body is a full refund", () => {
    const result = refundOrderSchema.safeParse({ params: { id: "ORD-1" }, body: {} });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.body).toEqual({ reason: "", items: [] });
    }
  });

  it("validates line shapes and the reason length", () => {
    expect(refundOrderSchema.safeParse({
      params: { id: "ORD-1" },
      body: { reason: "Damaged item", items: [{ id: "prod-1", qty: 1 }] },
    }).success).toBe(true);
    expect(refundOrderSchema.safeParse({
      params: { id: "ORD-1" },
      body: { items: [{ id: "prod-1", qty: 0 }] },
    }).success).toBe(false);
    expect(refundOrderSchema.safeParse({
      params: { id: "ORD-1" },
      body: { reason: "x".repeat(201) },
    }).success).toBe(false);
  });
});
