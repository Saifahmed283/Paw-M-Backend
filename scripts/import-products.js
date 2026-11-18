/**
 * Import the products extracted from the clinic's Excel sheet.
 *
 *   node scripts/import-products.js            # dry run (default, no DB writes)
 *   node scripts/import-products.js --apply    # write to the configured database
 *
 * The source file is `scripts/products-from-excel.json`. It keeps every row,
 * including incomplete ones (missing price / barcode / stock), so the clinic
 * can finish them in the dashboard later.
 *
 * Idempotency: `scripts/products-import-map.json` remembers source row ->
 * { id, owned }. Re-running `--apply` updates only products this importer
 * created (`owned: true`). Products that already existed and were merely
 * adopted by the import are never overwritten.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(here, "products-from-excel.json");
const mapFile = path.join(here, "products-import-map.json");
const apply = process.argv.includes("--apply");

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Same barcode can appear on several rows (different sizes / duplicates).
 *  Postgres enforces a unique barcode, so the first row keeps it and the rest
 *  are imported without one for the clinic to correct later. */
function prepareRows(rows) {
  const usedBarcodes = new Set();
  let clearedBarcodes = 0;
  const prepared = rows.map((row) => {
    const barcode = row.barcode?.trim() || null;
    let finalBarcode = barcode;
    if (barcode) {
      if (usedBarcodes.has(barcode)) {
        finalBarcode = null;
        clearedBarcodes += 1;
      } else {
        usedBarcodes.add(barcode);
      }
    }
    return { ...row, barcode: finalBarcode };
  });

  const seen = new Map();
  for (const row of prepared) {
    const base = row.barcode
      ? `barcode:${row.barcode}`
      : `row:${row.name.toLowerCase()}|${row.price}|${row.description}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    row.importKey = n > 1 ? `${base}#${n}` : base;
  }

  return { prepared, clearedBarcodes };
}

function toPrismaData(row) {
  return {
    name: row.name,
    description: row.description,
    price: row.price,
    stock: row.stock,
    category: row.category,
    petType: row.petType,
    barcode: row.barcode || null,
    image: row.image || "",
    featured: Boolean(row.featured),
  };
}

function same(record, data) {
  return Object.keys(data).every((k) => {
    const a = record[k];
    const b = data[k];
    if (a == null && b == null) return true;
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.0001;
    return a === b;
  });
}

async function main() {
  const rows = readJson(dataFile, null);
  if (!Array.isArray(rows)) throw new Error(`Missing or invalid ${dataFile}`);
  const { prepared, clearedBarcodes } = prepareRows(rows);

  console.log(`Source rows:            ${rows.length}`);
  console.log(`Duplicate barcodes cleared: ${clearedBarcodes}`);
  console.log(`With barcode:           ${prepared.filter((r) => r.barcode).length}`);
  console.log(`Missing price (set 0):  ${prepared.filter((r) => !r.price).length}`);
  console.log(`Missing stock (set 0):  ${prepared.filter((r) => !r.stock).length}`);

  if (!apply) {
    console.log("\nDRY RUN — no database writes. Re-run with --apply to import.");
    console.log("First 3 records:");
    for (const row of prepared.slice(0, 3)) console.log(" ", toPrismaData(row));
    return;
  }

  const prisma = new PrismaClient();
  const map = readJson(mapFile, {});
  const stats = { created: 0, updated: 0, unchanged: 0, existing: 0, failed: 0 };

  try {
    for (const row of prepared) {
      const data = toPrismaData(row);
      try {
        // Only products this importer created are ever updated. A pre-existing
        // product that happens to share a barcode or name is left untouched so
        // curated images/descriptions are never clobbered by spreadsheet data.
        const known = map[String(row.sourceRow)];
        const owned = known?.owned
          ? await prisma.product.findUnique({ where: { id: known.id } })
          : null;

        if (owned) {
          if (same(owned, data)) {
            stats.unchanged += 1;
          } else {
            await prisma.product.update({ where: { id: owned.id }, data });
            stats.updated += 1;
          }
          map[String(row.sourceRow)] = { id: owned.id, owned: true };
          continue;
        }

        const existing = row.barcode
          ? await prisma.product.findUnique({ where: { barcode: row.barcode } })
          : await prisma.product.findFirst({
              where: { name: data.name, category: data.category, price: data.price },
            });

        if (existing) {
          stats.existing += 1;
          map[String(row.sourceRow)] = { id: existing.id, owned: false };
          continue;
        }

        const created = await prisma.product.create({ data });
        stats.created += 1;
        map[String(row.sourceRow)] = { id: created.id, owned: true };
      } catch (err) {
        stats.failed += 1;
        console.error(`row ${row.sourceRow} (${row.name}): ${err.message}`);
      }
    }

    fs.writeFileSync(mapFile, `${JSON.stringify(map, null, 2)}\n`, "utf8");
    console.log("\nImport complete:", stats);
    console.log(`Id map saved to ${mapFile}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
