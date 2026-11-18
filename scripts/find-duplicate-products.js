/**
 * Report duplicate products in the catalogue (read-only).
 *
 * Groups by several keys so we can see near-duplicates created by the Excel
 * import: exact barcode, normalized name, and name+category. Run with:
 *   node scripts/find-duplicate-products.js
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const norm = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

async function main() {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      name: true,
      barcode: true,
      category: true,
      price: true,
      stock: true,
      createdAt: true,
      description: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log("Total products:", products.length);

  const groupBy = (keyFn) => {
    const m = new Map();
    for (const p of products) {
      const k = keyFn(p);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return [...m.entries()].filter(([, v]) => v.length > 1);
  };

  const byBarcode = groupBy((p) => p.barcode?.trim() || null);
  const byName = groupBy((p) => norm(p.name));
  const byNameCat = groupBy((p) => `${norm(p.name)}|${norm(p.category)}`);

  console.log("\nDuplicate barcode groups:", byBarcode.length);
  console.log("Duplicate name groups:", byName.length);
  console.log("Duplicate name+category groups:", byNameCat.length);

  const showGroup = ([key, items]) => {
    console.log(`\n  KEY: ${key}  (${items.length})`);
    for (const p of items) {
      console.log(
        `    ${p.id} | "${p.name}" | cat=${p.category} | price=${p.price} | stock=${p.stock} | barcode=${p.barcode ?? "-"} | ${p.createdAt?.toISOString?.() ?? p.createdAt}`,
      );
    }
  };

  if (byName.length) {
    console.log("\n=== DUPLICATE NAME GROUPS (first 60) ===");
    byName.slice(0, 60).forEach(showGroup);
  }

  if (byBarcode.length && !byName.length) {
    console.log("\n=== DUPLICATE BARCODE GROUPS ===");
    byBarcode.slice(0, 60).forEach(showGroup);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
