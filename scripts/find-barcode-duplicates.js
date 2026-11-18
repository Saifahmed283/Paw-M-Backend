/** Find products that came from Excel rows sharing the same source barcode. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, f), "utf8"));
const rawRows = read("products-excel-raw.json");
const importMap = read("products-import-map.json");
const rawByExcelRow = new Map(rawRows.map((r) => [r.excelRow, r]));

const groups = new Map();
for (const [sourceRow, info] of Object.entries(importMap)) {
  const raw = rawByExcelRow.get(Number(sourceRow) + 1);
  const barcode = raw?.barcode?.trim();
  if (!barcode || barcode === "-") continue;
  if (!groups.has(barcode)) groups.set(barcode, []);
  groups.get(barcode).push({ sourceRow: Number(sourceRow), id: info?.id, raw });
}

const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
console.log("Source-barcode groups with >1 product:", dupes.length);
for (const [barcode, items] of dupes) {
  console.log(`\n=== barcode ${barcode} (${items.length}) ===`);
  for (const it of items) {
    console.log(
      `  src=${it.sourceRow} id=${it.id} name="${it.raw.name}" cat=${it.raw.category} type=${it.raw.type} size="${it.raw.size}" price=${it.raw.price} stock=${it.raw.stock}`,
    );
  }
}
