# Product data import

`products-from-excel.json` is the normalized extraction of the clinic's
`منتجات.xlsx` spreadsheet — all 1,078 rows, including incomplete ones. Rows with
a missing price, stock or barcode are intentionally kept: the clinic finishes
them in the dashboard later.

## Usage

```bash
# Preview the normalized data (no database writes)
npm run db:import-products

# Apply to the database configured in .env
npm run db:import-products:apply
```

## Behaviour

- The importer is **additive**. It creates missing products and never overwrites
  an existing, curated product — even if that product shares a barcode or name
  with a spreadsheet row.
- `products-import-map.json` maps each source row to its product id. Re-running
  `--apply` is safe: rows this importer created are left unchanged (or updated
  if the source JSON was edited); adopted pre-existing rows are skipped.
- Barcodes that appear on more than one spreadsheet row keep the first row's
  barcode; the rest are imported with no barcode so the clinic can correct them.
- Missing `Price` and `Stock` become `0`, missing `Category` becomes
  `Uncategorized`, `K/g` and `Type` are preserved in `description`, and
  `Type` is mapped to `petType` (`For cats` → `cat`, `For dogs` → `dog`).

Import result on first apply: 1,076 created, 0 failed. Two spreadsheet rows
(`alpha dog 20kg adult` and `Gold Soap 5L`) were exact duplicates of earlier
rows and were folded into those products, so the catalogue contains 1,076
unique items from 1,078 source rows.

## Catalogue de-duplication

The spreadsheet lists several items more than once (sometimes under a shorter
name or with incomplete data). `dedupe-products.js` cleans this up:

```bash
node scripts/dedupe-products.js            # dry run — prints the full plan
node scripts/dedupe-products.js --apply    # apply to the configured database
```

- **Merge**: same-name products that share a spreadsheet barcode are the same
  item. The most complete record is kept; reviews and stock movements are
  re-pointed before the loose copies are deleted.
- **Rename**: same-name products with different barcodes are real size variants
  (e.g. a 4 kg and a 1 kg bag). All are kept, but the spreadsheet `K/g` value
  is appended to the name so the store no longer shows identical-looking cards.
  Where the sheet has no size, the price (and barcode tail if needed) is used.

`products-excel-raw.json` is the raw cell dump of `منتجات.xlsx`, including the
`K/g` column that the normalized import data dropped. `find-duplicate-products.js`
reports any remaining duplicate names/barcodes; `find-barcode-duplicates.js`
audits duplicate barcodes in the source sheet. After cleanup the catalogue has
1,075 products and zero duplicate names.

## Categories and stock

The spreadsheet left most category cells blank, so the importer produced over
1,000 `Uncategorized` products. `categorize-products.js` derives a real category
from each product name and applies it to every product (dry run by default):

```bash
node scripts/categorize-products.js            # preview counts and examples
node scripts/categorize-products.js --apply    # write categories
node scripts/categorize-products.js --all      # list every product per category
```

Result: food 608, accessories 253, litter 79, grooming 48, treats 42, toys 26,
health 19. `inspect-categories.js` prints the current database distribution.

`set-all-stock.js` sets every product's stock quantity to 5 (dry run by default):

```bash
node scripts/set-all-stock.js
node scripts/set-all-stock.js --apply
```

Both scripts are safe to re-run. The frontend treats a stock level of exactly 5
as healthy so the whole catalogue is not shown as "low stock".
