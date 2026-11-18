/**
 * Clean up duplicates created by the Excel import.
 *
 *   node scripts/dedupe-products.js            # dry run (no DB writes)
 *   node scripts/dedupe-products.js --apply    # write to the configured database
 *
 * Two operations, matching the agreed cleanup:
 *   1. MERGE  - same-name products that came from the same spreadsheet barcode
 *               are the same item entered twice. Keep the most complete record,
 *               re-point reviews/stock movements, then delete the loose copies.
 *   2. RENAME - same-name products with different barcodes are genuine size
 *               variants. Keep them all, but append the Excel "K/g" value to
 *               the name so the store no longer shows identical-looking cards.
 *
 * The import map is updated so re-running the importer will not resurrect a
 * merged duplicate.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const here = path.dirname(fileURLToPath(import.meta.url));
const apply = process.argv.includes("--apply");
const read = (f) => JSON.parse(fs.readFileSync(path.join(here, f), "utf8"));
const mapFile = path.join(here, "products-import-map.json");
const rawRows = read("products-excel-raw.json");
const importMap = read("products-import-map.json");
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// sourceRow is the 1-based index among data rows; Excel row = sourceRow + 1.
const rawBySourceRow = new Map(rawRows.map((r) => [r.excelRow - 1, r]));
const productToSourceRow = new Map();
for (const [sourceRow, info] of Object.entries(importMap)) {
  if (info?.id && !productToSourceRow.has(info.id)) productToSourceRow.set(info.id, Number(sourceRow));
}

function sizeSuffix(size) {
  const s = String(size ?? "").trim();
  if (!s || s === "-") return "";
  const n = s.toLowerCase().replace(/\s+/g, "");
  if (/l$/.test(n) && !n.includes("kg")) return `${n.replace(/l$/, "").trim()} L`;
  const g = n.match(/^([\d.]+)g$/);
  if (g) return `${g[1]} g`;
  const kg = n.match(/^([\d.]+)kg$/);
  if (kg) return `${kg[1]} kg`;
  if (/^\d+(\.\d+)?$/.test(n)) return `${n} kg`;
  return s;
}

function score(p, src) {
  return (
    (p.category && p.category !== "Uncategorized" ? 3 : 0) +
    (p.description?.trim() ? 2 : 0) +
    (p.stock > 0 ? 2 : 0) +
    (p.image?.trim() ? 1 : 0) +
    (p.barcode ? 1 : 0) +
    (p.price > 0 ? 1 : 0) +
    (src?.name ? 1 : 0) +
    Math.min(3, String(p.name).length / 30)
  );
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
  const dupeGroups = [...groups.entries()].filter(([, v]) => v.length > 1);

  const merges = [];
  const renames = [];

  for (const [key, items] of dupeGroups) {
    const detailed = items.map((p) => {
      const sRow = productToSourceRow.get(p.id);
      const raw = rawBySourceRow.get(sRow);
      return { p, sRow, raw, barcode: raw?.barcode?.trim() || "" };
    });

    // Group members by their spreadsheet barcode. A shared barcode means the
    // sheet listed the same physical item more than once under the same name.
    const byBarcode = new Map();
    for (const d of detailed) {
      if (!d.barcode || d.barcode === "-") continue;
      if (!byBarcode.has(d.barcode)) byBarcode.set(d.barcode, []);
      byBarcode.get(d.barcode).push(d);
    }

    const mergedIds = new Set();
    for (const [, members] of byBarcode) {
      if (members.length < 2) continue;
      const ranked = [...members].sort(
        (a, b) => score(b.p, b.raw) - score(a.p, a.raw) || (a.sRow ?? 0) - (b.sRow ?? 0),
      );
      const keep = ranked[0];
      const drop = ranked.slice(1);
      merges.push({ key, keep, drop });
      drop.forEach((d) => mergedIds.add(d.p.id));
    }

    // Whatever remains is a set of distinct size variants: keep every product,
    // just make the names distinguishable.
    const survivors = detailed.filter((d) => !mergedIds.has(d.p.id));
    if (survivors.length < 2) continue;
    for (const s of survivors) {
      const suffix = sizeSuffix(s.raw?.size);
      const newName = suffix
        ? `${s.p.name.trim()} ${suffix}`
        : `${s.p.name.trim()} (${s.p.price} EGP)`;
      renames.push({
        id: s.p.id,
        oldName: s.p.name,
        newName,
        src: s.sRow,
        size: s.raw?.size,
        barcode: s.p.barcode || s.raw?.barcode || "",
      });
    }
  }

  // If two variants still land on the same label (same price and no size),
  // disambiguate with the last four barcode digits.
  const usedNames = new Set();
  for (const r of renames) {
    if (usedNames.has(r.newName) && r.barcode) {
      r.newName = `${r.newName} #${r.barcode.slice(-4)}`;
    }
    usedNames.add(r.newName);
  }

  console.log(`Products: ${products.length}`);
  console.log(`Duplicate-name groups: ${dupeGroups.length}`);
  console.log(`Merge plans: ${merges.length}`);
  for (const m of merges) {
    console.log(
      `  MERGE "${m.key}": keep ${m.keep.p.id} (src ${m.keep.sRow}, price ${m.keep.p.price}, stock ${m.keep.p.stock})`,
    );
    for (const d of m.drop) {
      console.log(`        drop ${d.p.id} (src ${d.sRow}, price ${d.p.price}, stock ${d.p.stock})`);
    }
  }
  console.log(`Rename plans: ${renames.length}`);
  for (const r of renames) {
    console.log(`  RENAME ${r.id}: "${r.oldName}" -> "${r.newName}" (src ${r.src}, K/g=${r.size ?? "-"})`);
  }

  if (!apply) {
    console.log("\nDRY RUN — no database writes. Re-run with --apply to apply.");
    return;
  }

  let merged = 0;
  let renamed = 0;
  for (const m of merges) {
    for (const d of m.drop) {
      await prisma.review.updateMany({
        where: { productId: d.p.id },
        data: { productId: m.keep.p.id },
      });
      await prisma.stockMovement.updateMany({
        where: { productId: d.p.id },
        data: { productId: m.keep.p.id },
      });
      // Free the duplicate's DB barcode before deleting it so the kept record
      // can safely take over if the sheet had put the barcode on a later row.
      if (d.p.barcode) {
        await prisma.product.update({ where: { id: d.p.id }, data: { barcode: null } });
      }
      await prisma.product.delete({ where: { id: d.p.id } });
      merged += 1;
    }
    // Make sure the kept product carries the group's barcode.
    const barcode = m.keep.p.barcode || m.drop.find((d) => d.p.barcode)?.p.barcode;
    if (barcode && m.keep.p.barcode !== barcode) {
      await prisma.product.update({ where: { id: m.keep.p.id }, data: { barcode } });
    }
    for (const d of [m.keep, ...m.drop]) {
      if (importMap[String(d.sRow)]) {
        importMap[String(d.sRow)] = { id: m.keep.p.id, owned: false };
      }
    }
  }
  for (const r of renames) {
    await prisma.product.update({ where: { id: r.id }, data: { name: r.newName } });
    renamed += 1;
  }
  fs.writeFileSync(mapFile, `${JSON.stringify(importMap, null, 2)}\n`, "utf8");
  console.log(`\nApplied: ${merged} duplicate products merged, ${renamed} variants renamed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
