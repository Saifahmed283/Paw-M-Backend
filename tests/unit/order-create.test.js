import { describe, it, expect, vi } from "vitest";
import { createOrderTransactional } from "../../src/services/orders.js";

function makeTx() {
  const product = { id: "prod-1", name: "Dog Food", price: 200, stock: 5, image: "img.jpg" };
  return {
    product: {
      findUnique: vi.fn(async ({ where }) => (where.id === product.id ? product : null)),
      update: vi.fn(async () => ({})),
    },
  };
}

describe("createOrderTransactional service lines", () => {
  it("accepts clinic services at a manually entered price without touching products", async () => {
    const tx = makeTx();
    const result = await createOrderTransactional(
      tx,
      {
        items: [
          {
            id: "service-pharmacy",
            name: "Pharmacy — patient: Luna",
            price: 350,
            qty: 1,
          },
        ],
        discountAmount: 50,
      },
      true,
    );

    expect(result.total).toBe(300);
    expect(result.lines).toEqual([
      {
        id: "service-pharmacy",
        name: "Pharmacy — patient: Luna",
        price: 350,
        qty: 1,
        image: "",
      },
    ]);
    expect(tx.product.findUnique).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("keeps product stock rules while adding service lines in a mixed sale", async () => {
    const tx = makeTx();
    const result = await createOrderTransactional(
      tx,
      {
        items: [
          { id: "prod-1", name: "Dog Food", price: 180, qty: 2 },
          { id: "service-general-checkup", name: "Check-up", price: 300, qty: 1 },
        ],
      },
      true,
    );

    expect(result.total).toBe(660); // 360 discounted food + 300 service
    expect(result.lines.map((l) => l.id)).toEqual(["prod-1", "service-general-checkup"]);
    expect(tx.product.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.product.update).toHaveBeenCalledTimes(1);
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "prod-1" },
      data: { stock: { decrement: 2 } },
    });
  });

  it("rejects service lines on non-POS orders and invalid manual prices", async () => {
    const storeTx = makeTx();
    await expect(
      createOrderTransactional(
        storeTx,
        { items: [{ id: "service-pharmacy", name: "Pharmacy", price: 350, qty: 1 }] },
        false,
      ),
    ).rejects.toMatchObject({ status: 400 });

    const badPriceTx = makeTx();
    await expect(
      createOrderTransactional(
        badPriceTx,
        { items: [{ id: "service-pharmacy", name: "Pharmacy", price: -1, qty: 1 }] },
        true,
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("service price") });
  });
});
