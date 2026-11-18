import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

const prisma = new PrismaClient();
const rows = JSON.parse(
  fs.readFileSync(new URL("./products-excel-raw.json", import.meta.url), "utf8"),
);

const db = await prisma.product.groupBy({
  by: ["category"],
  _count: { _all: true },
  orderBy: { _count: { category: "desc" } },
});
console.log("=== DB product categories ===");
for (const g of db) console.log(`  ${g.category}: ${g._count._all}`);

const excel = new Map();
for (const r of rows) {
  const c = r.category || "(blank)";
  excel.set(c, (excel.get(c) ?? 0) + 1);
}
console.log("\n=== Raw Excel categories ===");
for (const [c, n] of [...excel].sort((a, b) => b[1] - a[1])) console.log(`  ${c}: ${n}`);

await prisma.$disconnect();
