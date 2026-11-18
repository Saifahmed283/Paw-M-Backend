/**
 * Analyse duplicate-name product groups and propose a safe cleanup.
 * Read-only. Prints a plan; see scripts/dedupe-products.js to apply.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, f), "utf8"));
const rawRows = read("products-excel-raw.json");
const sourceRows = read("products-from-excel.json");
const importMap = read("products-import-map.json");
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// productId -> sourceRow (first one wins if several rows folded into one)
const rowOfProduct = new Map();
for (const [sourceRow, info] of Object.entries(importMap)) {
  if (info?.id && !rowOfProduct.has(info.id)) rowOfProduct.set(info.id, Number(sourceRow));
}
const rawByExcelRow = new Map(rawRows.map((r) => [r.excelRow, r]));
// products-from-excel.json sourceRow equals the Excel row number? Verify with 'no' column.
const sourceByRow = new Map(sourceRows.map((r) => [r.sourceRow, r]));

function sizeSuffix(size) {
  const s = String(size ?? "").trim();
  if (!s || s === "-") return "";
  const lower = s.toLowerCase();
  const num = lower.replace(/\s+/g, "");
  if (/l$/.test(num) && !num.includes("kg")) {
    return `${num.replace(/l$/, "").trim()} L`;
  }
  const g = num.match(/^([\d.]+)g$/);
  if (g) return `${g[1]} g`;
  const kg = num.match(/^([\d.]+)kg$/);
  if (kg) return `${kg[1]} kg`;
  if (/^\d+(\.\d+)?$/.test(num)) return `${num} kg`;
  return s;
}

const prisma = new PrismaClient();

async function main() {
  const products = await prisma.product.findMany({ orderBy: { createdAt: "asc" } });
  const groups = new Map();
  for (const p of products) {
    const k = norm(p.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
  console.log("Total products:", products.length);
  console.log("Duplicate-name groups:", dupes.length);

  for (const [key, items] of dupes) {
    console.log(`\n=== ${key} (${items.length}) ===`);
    const barcodes = [];
    for (const p of items) {
      const sRow = rowOfProduct.get(p.id);
      // sourceRow is the 1-based index among data rows; Excel row = sourceRow + 1.
      const raw = rawByExcelRow.get(sRow + 1);
      const src = sourceByRow.get(sRow);
      const barcode = raw?.barcode || p.barcode || "-";
      barcodes.push(barcode);
      const suffix = sizeSuffix(raw?.size);
      const score =
        (src?.description ? 2 : 0) +
        (p.category && p.category !== "Uncategorized" ? 2 : 0) +
        (p.stock > 0 ? 1 : 0) +
        (p.image ? 1 : 0);
      console.log(
        `  id=${p.id} src=${sRow} barcode=${barcode} size="${raw?.size ?? ""}" suffix="${suffix}" price=${p.price} stock=${p.stock} cat=${p.category} desc="${p.description}" score=${score}`,
      );
    }
    const uniqueBarcodes = new Set(barcodes.filter((b) => b !== "-"));
    console.log(
      `  => ${uniqueBarcodes.size === 1 && barcodes.every((b) => b !== "-") ? "TRUE DUPLICATE (same barcode) - merge" : "SIZE VARIANTS - rename with size"}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
