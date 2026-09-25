const path = require("path");
const BACKEND = "C:\\My-Projects\\Paw-M\\Paw-M-Backend";
require(path.join(BACKEND, "node_modules", "dotenv")).config({ path: path.join(BACKEND, ".env") });
const { PrismaClient } = require(path.join(BACKEND, "node_modules", "@prisma", "client"));
const prisma = new PrismaClient();

async function main() {
  const importAt = new Date("2026-09-25T16:23:35.744Z");
  const candidates = await prisma.product.findMany({
    where: { createdAt: { gte: new Date(importAt.getTime() - 60_000) } },
    select: { id: true, name: true },
  });
  const ids = new Set(candidates.map((p) => p.id));
  const names = candidates.map((p) => p.name.toLowerCase());

  const orders = await prisma.order.findMany({ select: { id: true, items: true } }).catch(() => null);
  if (!orders) { console.log("Order query unavailable"); return; }
  console.log("total orders:", orders.length);

  let idHits = 0, nameHits = 0;
  const examples = [];
  for (const o of orders) {
    const raw = typeof o.items === "string" ? JSON.parse(o.items) : o.items;
    if (!Array.isArray(raw)) continue;
    for (const it of raw) {
      if (it?.id && ids.has(it.id)) { idHits++; if (examples.length < 5) examples.push({ order: o.id, ...it }); }
      else if (it?.name && names.includes(String(it.name).toLowerCase())) {
        nameHits++; if (examples.length < 5) examples.push({ order: o.id, matchBy: "name", ...it });
      }
    }
  }
  console.log("order line-items referencing candidate products by id:  ", idHits);
  console.log("order line-items referencing candidate products by name:", nameHits);
  if (examples.length) console.log("examples:", JSON.stringify(examples, null, 2).slice(0, 800));

  const pay = await prisma.payment.count().catch(() => null);
  console.log("payment rows:", pay);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error("ERR", String(e.message).slice(0, 300)); await prisma.$disconnect(); process.exit(1); });
