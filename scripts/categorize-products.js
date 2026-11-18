/**
 * Categorize the imported catalogue so filters actually have groups to show.
 *
 *   node scripts/categorize-products.js            # dry run
 *   node scripts/categorize-products.js --apply    # write categories to the DB
 *
 * The spreadsheet left ~1012 category cells blank, so almost the whole
 * catalogue was "Uncategorized". These rules derive a usable category from
 * the product name (and the size hint stored in the description). Rules are
 * ordered from most specific to least specific; anything unmatched is food,
 * which is by far the dominant product type in this catalogue.
 */
import { PrismaClient } from "@prisma/client";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();

// Order matters: a "flea shampoo" is grooming, a "flea treatment" is health.
const RULES = [
  // NOTE: don't match a bare "\d+ L" here — product codes like "DCS006-01L"
  // would be misread as litre-sized litter.
  ["litter", /\b(litter|clump\w*|bentonite|silica\s*ge?l|sanicat|citycat|kitty friend|kikikat|tidy tales|ramlah|king clean|benty\s*sandy|cat town|jingo|migato|gold|sherif|vitamax|plaza|snow white|kitty|lamp)\b/i],
  // NOTE: no bare "toy" — "Small & Toy Breed" is dog food, not a toy.
  ["toys", /(chew\s*toy|squeaky|plush|rubber ball|dog toy|cat toy)/i],
  ["grooming", /(shampoo|\bsoap\b|slicker|\bbrush\b|\bcomb\b|lint roller|wipes|perfume|powder|toothbrush|dental care|nail clipper|dry foam|dry shampoo|grooming|\bpure kit\b)/i],
  ["health", /(deworm|antiparasit|anti-flea|anti-fleas|\bflea\b|\bticks?\b|\blice\b|antibiotic|clindamycin|supplement|spot-on|revolution|frontline|bravecto|drontal|clindamed|synoquin|vetplus|vet expert|aquadent|pronefra|medicated|heartworm|\btablets?\b|dermatological|oral solution|soothing spray|dental solution|\bguard\b)/i],
  ["treats", /(treats?|biscuit|\bsticks?\b|rawhide|creamy|snack|cowhide|\bpieces?\b)/i],
  ["accessories", /(collar|leash|harness|muzzle|carrier|\bcrate\b|hoodie|t-shirt|water bottle|\bscoop\b|underpads)/i],
];

function categorize(name, description = "") {
  const text = `${name} ${description}`;
  for (const [cat, re] of RULES) if (re.test(text)) return cat;
  return "food";
}

const products = await prisma.product.findMany({
  select: { id: true, name: true, category: true, description: true },
  orderBy: { name: "asc" },
});

const counts = new Map();
const samples = new Map();
const changed = [];
for (const p of products) {
  const next = categorize(p.name, p.description);
  counts.set(next, (counts.get(next) ?? 0) + 1);
  if (!samples.has(next)) samples.set(next, []);
  if (samples.get(next).length < (process.argv.includes("--all") ? 10000 : 8))
    samples.get(next).push(p.name);
  if (p.category.toLowerCase() !== next) changed.push({ name: p.name, from: p.category, to: next });
}

console.log(`Products: ${products.length}`);
console.log("\n=== Proposed categories ===");
for (const [cat, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat.padEnd(12)} ${String(n).padStart(4)}`);
  console.log(`      e.g. ${samples.get(cat).join(" | ")}`);
}
console.log(`\nCategories changed from current DB values: ${changed.length}`);
for (const c of changed.slice(0, 40)) console.log(`  ${c.from} -> ${c.to}: ${c.name}`);

if (!apply) {
  console.log("\nDRY RUN — no database writes. Re-run with --apply to apply.");
  await prisma.$disconnect();
  process.exit(0);
}

// Apply category changes with a single bulk update per target category.
const byCategory = new Map();
for (const p of products) {
  const next = categorize(p.name, p.description);
  if (!byCategory.has(next)) byCategory.set(next, []);
  byCategory.get(next).push(p.id);
}
for (const [cat, ids] of byCategory) {
  // updateMany avoids one round-trip per product.
  await prisma.product.updateMany({ where: { id: { in: ids } }, data: { category: cat } });
  console.log(`Updated ${ids.length} products -> ${cat}`);
}

await prisma.$disconnect();
