import { describe, it, expect, vi } from "vitest";
import { mockPrisma } from "../setup.js";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

import { syncPaymentToOrder } from "../../src/services/payment-status.js";

describe("Payment mirror guard", () => {
  it("refuses to settle an order from a Finance payment edit", async () => {
    await expect(syncPaymentToOrder(mockPrisma, {
      orderId: "ORD-1", kind: "order", status: "paid", method: "cash",
    })).rejects.toMatchObject({
      status: 400,
      message: "Order payments are settled through verification only.",
    });
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it("ignores non-order payments (visit/manual keep their own flow)", async () => {
    await expect(syncPaymentToOrder(mockPrisma, {
      orderId: "ORD-1", kind: "visit", status: "paid", method: "cash",
    })).resolves.toBeNull();
  });
});
