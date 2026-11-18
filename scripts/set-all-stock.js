/**
 * Reset every product's stock quantity to 5.
 *
 *   node scripts/set-all-stock.js            # dry run
 *   node scripts/set-all-stock.js --apply    # write to the configured database
 */
import { PrismaClient } from "@prisma/client";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();

const aggregate = await prisma.product.aggregate({ _count: { _all: true } });
const total = aggregate._count._all;
const current = await prisma.product.groupBy({
  by: ["stock"],
  _count: { _all: true },
  orderBy: { stock: "asc" },
});

console.log(`Products: ${total}`);
console.log("Current stock distribution:");
for (const row of current) console.log(`  ${row.stock}: ${row._count._all}`);

if (!apply) {
  console.log(`\nDRY RUN — would set all ${total} products to stock = 5.`);
} else {
  const result = await prisma.product.updateMany({ data: { stock: 5 } });
  console.log(`\nUpdated ${result.count} products to stock = 5.`);
}

await prisma.$disconnect();
