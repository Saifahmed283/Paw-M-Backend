import express from "express";
import cors from "cors";
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const FRONTEND_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "https://d375-196-156-78-40.ngrok-free.app",
];

const VALID_STATUSES = ["pending", "confirmed", "completed", "cancelled"];

const app = express();
app.use(cors({ origin: FRONTEND_ORIGINS, credentials: true }));
app.use(express.json({ limit: "8mb" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

/** Fire-and-forget audit trail entry. Never throws. */
function logAudit(action, target = "", detail = "") {
  prisma.auditLog
    .create({ data: { action: String(action).slice(0, 80), target: String(target).slice(0, 120), detail: String(detail).slice(0, 400) } })
    .catch((e) => console.error("audit log failed:", e.message));
}

function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SHORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function shortCode(len = 6) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += SHORT_CODE_ALPHABET[Math.floor(Math.random() * SHORT_CODE_ALPHABET.length)];
  }
  return out;
}

/** Short, human-friendly unique id like "ORD-8F3K2A". */
async function nextId(prefix, model) {
  for (let i = 0; i < 6; i++) {
    const id = `${prefix}-${shortCode(6)}`;
    const exists = await prisma[model].findUnique({ where: { id } });
    if (!exists) return id;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

/** Archive every completed/cancelled booking + order that is not yet archived. */
async function archiveFinishedDayRecords() {
  const [bookings, orders] = await Promise.all([
    prisma.booking.findMany({
      where: { archived: false, status: { in: ["completed", "cancelled"] } },
      select: { id: true },
    }),
    prisma.order.findMany({
      where: { archived: false, status: { in: ["completed", "cancelled"] } },
      select: { id: true },
    }),
  ]);
  if (bookings.length > 0) {
    await prisma.booking.updateMany({
      where: { id: { in: bookings.map((b) => b.id) } },
      data: { archived: true },
    });
  }
  if (orders.length > 0) {
    await prisma.order.updateMany({
      where: { id: { in: orders.map((o) => o.id) } },
      data: { archived: true },
    });
  }
  for (const b of bookings) logAudit("auto_archive", b.id, "Booking auto-archived at shift end");
  for (const o of orders) logAudit("auto_archive", o.id, "Order auto-archived at shift end");
  return { bookings: bookings.length, orders: orders.length };
}

// ── Work sessions (check-in / check-out) ─────────────────────────────────────

/** Current open session, if any. */
app.get("/api/work-session", async (_req, res) => {
  try {
    const session = await prisma.workSession.findFirst({
      where: { endedAt: null },
      orderBy: { startedAt: "desc" },
    });
    res.json(session ?? null);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load work session" });
  }
});

/**
 * Check in: starts today's shift. If the previous shift was never closed
 * (leftover from a previous day), it is closed and its finished records are
 * auto-archived — a new day always starts clean.
 */
app.post("/api/work-session/check-in", async (_req, res) => {
  try {
    const open = await prisma.workSession.findFirst({
      where: { endedAt: null },
      orderBy: { startedAt: "desc" },
    });
    if (open) {
      if (todayStr(open.startedAt) !== todayStr()) {
        const archived = await archiveFinishedDayRecords();
        await prisma.workSession.update({
          where: { id: open.id },
          data: { endedAt: new Date() },
        });
        logAudit("check_out", open.id, "Previous shift auto-closed on new check-in");
        logAudit("check_in", "", `Checked in — auto-archived ${archived.bookings} bookings and ${archived.orders} orders from previous shift`);
        const session = await prisma.workSession.create({ data: { date: todayStr() } });
        return res.status(201).json({ session, archived });
      }
      return res.json({ session: open, archived: { bookings: 0, orders: 0 } });
    }
    const session = await prisma.workSession.create({ data: { date: todayStr() } });
    logAudit("check_in", session.id, "Checked in");
    res.status(201).json({ session, archived: { bookings: 0, orders: 0 } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to check in" });
  }
});

/**
 * Check out: ends the shift. All completed/cancelled requests and orders are
 * archived with the day's records, and the shift is closed.
 */
app.post("/api/work-session/check-out", async (_req, res) => {
  try {
    const open = await prisma.workSession.findFirst({
      where: { endedAt: null },
      orderBy: { startedAt: "desc" },
    });
    if (!open) return res.status(400).json({ error: "You are not checked in." });
    const archived = await archiveFinishedDayRecords();
    const ended = await prisma.workSession.update({
      where: { id: open.id },
      data: { endedAt: new Date() },
    });
    logAudit("check_out", open.id, `Checked out — archived ${archived.bookings} bookings and ${archived.orders} orders`);
    res.json({ session: ended, archived });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to check out" });
  }
});

/** Audit trail: newest first. */
app.get("/api/audit-logs", async (_req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    res.json(logs);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load audit logs" });
  }
});

// ── Daily workday folders ────────────────────────────────────────────────────

/**
 * Every day that has any activity (bookings, orders, payments or a shift)
 * becomes a "folder". Each folder reports what happened that day: how many
 * appointments/orders/payments and the revenue from orders and payments.
 */
app.get("/api/work-days", async (_req, res) => {
  try {
    const [bookings, orders, payments, sessions] = await Promise.all([
      prisma.booking.findMany({ select: { id: true, date: true, status: true } }),
      prisma.order.findMany({ select: { id: true, createdAt: true, total: true, status: true } }),
      prisma.payment.findMany({ select: { id: true, date: true, amount: true, status: true } }),
      prisma.workSession.findMany({
        select: { id: true, date: true, startedAt: true, endedAt: true },
        orderBy: { startedAt: "desc" },
      }),
    ]);
    const days = new Map();
    const addDay = (day) => {
      if (!days.has(day)) {
        days.set(day, {
          date: day,
          bookings: 0,
          orders: 0,
          payments: 0,
          revenue: 0,
          paymentsTotal: 0,
          session: null,
        });
      }
    };
    for (const b of bookings) {
      addDay(b.date);
      days.get(b.date).bookings++;
    }
    for (const o of orders) {
      const day = todayStr(new Date(o.createdAt));
      addDay(day);
      const d = days.get(day);
      d.orders++;
      if (o.status !== "cancelled") d.revenue += o.total;
    }
    for (const p of payments) {
      addDay(p.date);
      const d = days.get(p.date);
      d.payments++;
      if (p.status === "paid") d.paymentsTotal += p.amount;
    }
    for (const s of sessions) {
      addDay(s.date);
      if (!days.get(s.date).session) {
        days.get(s.date).session = { id: s.id, startedAt: s.startedAt, endedAt: s.endedAt };
      }
    }
    const list = [...days.values()]
      .map((d) => ({
        ...d,
        revenue: Math.round(d.revenue * 100) / 100,
        paymentsTotal: Math.round(d.paymentsTotal * 100) / 100,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load workday folders" });
  }
});

/** Full contents of one day's folder: appointments, sales, payments, activity. */
app.get("/api/work-days/:date", async (req, res) => {
  const day = String(req.params.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return res.status(400).json({ error: "Date must be YYYY-MM-DD." });
  }
  try {
    const start = new Date(`${day}T00:00:00`);
    const end = new Date(`${day}T23:59:59.999`);
    const [bookings, orders, payments, session, logs] = await Promise.all([
      prisma.booking.findMany({ where: { date: day }, orderBy: { time: "asc" } }),
      prisma.order.findMany({
        where: { createdAt: { gte: start, lte: end } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.payment.findMany({ where: { date: day }, orderBy: { createdAt: "desc" } }),
      prisma.workSession.findFirst({
        where: { date: day },
        orderBy: { startedAt: "desc" },
      }),
      prisma.auditLog.findMany({
        where: { createdAt: { gte: start, lte: end } },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
    ]);
    res.json({ date: day, session, bookings, orders, payments, logs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load workday folder" });
  }
});

app.get("/api/health", (_req, res) => res.json({ status: "ok", db: "connected" }));

// ── Bookings ───────────────────────────────────────────────────────────────

app.get("/api/bookings", async (_req, res) => {
  try {
    const bookings = await prisma.booking.findMany({ orderBy: { createdAt: "desc" } });
    res.json(bookings);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
});

app.post("/api/bookings", async (req, res) => {
  const body = req.body ?? {};
  try {
    const record = await prisma.booking.create({
      data: {
        id: await nextId("REQ", "booking"),
        ownerName: String(body.ownerName ?? ""),
        phone: String(body.phone ?? ""),
        email: String(body.email ?? ""),
        petName: String(body.petName ?? ""),
        animalType: String(body.animalType ?? ""),
        breed: String(body.breed ?? ""),
        age: String(body.age ?? ""),
        weight: String(body.weight ?? ""),
        symptoms: String(body.symptoms ?? ""),
        allergies: String(body.allergies ?? ""),
        medications: String(body.medications ?? ""),
        doctorId: String(body.doctorId ?? ""),
        doctorName: String(body.doctorName ?? ""),
        date: String(body.date ?? ""),
        time: String(body.time ?? ""),
        emergency: Boolean(body.emergency ?? false),
      },
    });
    res.status(201).json(record);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

app.patch("/api/bookings/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body ?? {};
  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  }
  try {
    const updated = await prisma.booking.update({
      where: { id },
      data: { status },
    });
    logAudit("booking_status", id, `${updated.ownerName}'s booking → ${status}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Booking not found" });
  }
});

app.delete("/api/bookings/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.booking.findUnique({ where: { id } });
    await prisma.booking.delete({ where: { id } });
    logAudit("booking_delete", id, `Deleted booking for ${existing?.ownerName ?? "unknown"}`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Booking not found" });
  }
});

/** Archive or restore a booking (kept for records, hidden from active lists). */
app.patch("/api/bookings/:id/archive", async (req, res) => {
  const { id } = req.params;
  const archived = req.body?.archived === true;
  try {
    const updated = await prisma.booking.update({
      where: { id },
      data: { archived },
    });
    logAudit(archived ? "booking_archive" : "booking_restore", id, `${updated.ownerName}'s booking ${archived ? "archived" : "restored"}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Booking not found" });
  }
});

// ── Doctors ────────────────────────────────────────────────────────────────

app.get("/api/doctors", async (_req, res) => {
  try {
    const doctors = await prisma.doctor.findMany();
    res.json(doctors);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch doctors" });
  }
});

app.post("/api/doctors", async (req, res) => {
  const body = req.body ?? {};
  try {
    const created = await prisma.doctor.create({
      data: {
        id: String(body.id ?? `dr-${Date.now().toString(36)}`),
        name: String(body.name ?? ""),
        specialization: String(body.specialization ?? ""),
        experience: String(body.experience ?? ""),
        rating: Number(body.rating ?? 4.8),
        days: Array.isArray(body.days) ? body.days.map(String) : [],
        bio: String(body.bio ?? ""),
        initials: String(body.initials ?? ""),
        tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
        pets: Array.isArray(body.pets) ? body.pets.map(String) : [],
      },
    });
    logAudit("doctor_create", created.id, `Created doctor ${created.name}`);
    res.status(201).json(created);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create doctor" });
  }
});

app.patch("/api/doctors/:id", async (req, res) => {
  const { id } = req.params;
  const patch = req.body ?? {};
  try {
    const updated = await prisma.doctor.update({
      where: { id },
      data: {
        name: patch.name !== undefined ? String(patch.name) : undefined,
        specialization:
          patch.specialization !== undefined ? String(patch.specialization) : undefined,
        experience: patch.experience !== undefined ? String(patch.experience) : undefined,
        rating: patch.rating !== undefined ? Number(patch.rating) : undefined,
        days: Array.isArray(patch.days) ? patch.days.map(String) : undefined,
        bio: patch.bio !== undefined ? String(patch.bio) : undefined,
        initials: patch.initials !== undefined ? String(patch.initials) : undefined,
        tags: Array.isArray(patch.tags) ? patch.tags.map(String) : undefined,
        pets: Array.isArray(patch.pets) ? patch.pets.map(String) : undefined,
      },
    });
    logAudit("doctor_update", id, `Updated doctor ${updated.name}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Doctor not found" });
  }
});

app.delete("/api/doctors/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.doctor.findUnique({ where: { id } });
    await prisma.doctor.delete({ where: { id } });
    logAudit("doctor_delete", id, `Deleted doctor ${existing?.name ?? "unknown"}`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Doctor not found" });
  }
});

// ── Services ───────────────────────────────────────────────────────────────

app.get("/api/services", async (_req, res) => {
  try {
    const services = await prisma.service.findMany();
    res.json(services);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch services" });
  }
});

app.post("/api/services", async (req, res) => {
  const body = req.body ?? {};
  try {
    const created = await prisma.service.create({
      data: {
        slug: String(body.slug ?? `svc-${Date.now().toString(36)}`),
        icon: String(body.icon ?? "Stethoscope"),
        title: String(body.title ?? ""),
        description: String(body.description ?? ""),
      },
    });
    logAudit("service_create", created.slug, `Created service ${created.title}`);
    res.status(201).json(created);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create service" });
  }
});

app.patch("/api/services/:slug", async (req, res) => {
  const { slug } = req.params;
  const patch = req.body ?? {};
  try {
    const updated = await prisma.service.update({
      where: { slug },
      data: {
        icon: patch.icon !== undefined ? String(patch.icon) : undefined,
        title: patch.title !== undefined ? String(patch.title) : undefined,
        description: patch.description !== undefined ? String(patch.description) : undefined,
      },
    });
    logAudit("service_update", slug, `Updated service ${updated.title}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Service not found" });
  }
});

app.delete("/api/services/:slug", async (req, res) => {
  const { slug } = req.params;
  try {
    const existing = await prisma.service.findUnique({ where: { slug } });
    await prisma.service.delete({ where: { slug } });
    logAudit("service_delete", slug, `Deleted service ${existing?.title ?? "unknown"}`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Service not found" });
  }
});

// ── Products (store) ────────────────────────────────────────────────────────

const VALID_PET_TYPES = ["dog", "cat", "both"];

function sanitizePetType(value) {
  return VALID_PET_TYPES.includes(value) ? value : "both";
}

app.get("/api/products", async (_req, res) => {
  try {
    const products = await prisma.product.findMany({ orderBy: { createdAt: "desc" } });
    res.json(products);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch {
    res.status(404).json({ error: "Product not found" });
  }
});

app.post("/api/products", async (req, res) => {
  const body = req.body ?? {};
  const price = Number(body.price ?? 0);
  const stock = Number(body.stock ?? 0);
  const compareAt = body.compareAtPrice === undefined || body.compareAtPrice === null || body.compareAtPrice === ""
    ? null
    : Number(body.compareAtPrice);
  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: "price must be a positive number" });
  }
  if (compareAt !== null && (!Number.isFinite(compareAt) || compareAt < price)) {
    return res.status(400).json({ error: "compareAtPrice must be a number >= price" });
  }
  if (!Number.isInteger(stock) || stock < 0) {
    return res.status(400).json({ error: "stock must be a non-negative integer" });
  }
  try {
    const created = await prisma.product.create({
      data: {
        name: String(body.name ?? ""),
        description: String(body.description ?? ""),
        price,
        compareAtPrice: compareAt,
        image: String(body.image ?? ""),
        category: String(body.category ?? "accessories"),
        petType: sanitizePetType(String(body.petType ?? "both")),
        stock,
        featured: Boolean(body.featured ?? false),
      },
    });
    logAudit("product_create", created.id, `Created product ${created.name}`);
    res.status(201).json(created);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create product" });
  }
});

app.patch("/api/products/:id", async (req, res) => {
  const { id } = req.params;
  const patch = req.body ?? {};
  const data = {};
  if (patch.name !== undefined) data.name = String(patch.name);
  if (patch.description !== undefined) data.description = String(patch.description);
  if (patch.image !== undefined) data.image = String(patch.image);
  if (patch.category !== undefined) data.category = String(patch.category);
  if (patch.petType !== undefined) data.petType = sanitizePetType(String(patch.petType));
  if (patch.featured !== undefined) data.featured = Boolean(patch.featured);
  if (patch.price !== undefined) {
    const price = Number(patch.price);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: "price must be a positive number" });
    }
    data.price = price;
  }
  if (patch.compareAtPrice !== undefined) {
    if (patch.compareAtPrice === null || patch.compareAtPrice === "") {
      data.compareAtPrice = null;
    } else {
      const compareAt = Number(patch.compareAtPrice);
      if (!Number.isFinite(compareAt) || compareAt < 0) {
        return res.status(400).json({ error: "compareAtPrice must be a non-negative number" });
      }
      data.compareAtPrice = compareAt;
    }
  }
  if (patch.stock !== undefined) {
    const stock = Number(patch.stock);
    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({ error: "stock must be a non-negative integer" });
    }
    data.stock = stock;
  }
  try {
    const updated = await prisma.product.update({ where: { id }, data });
    logAudit("product_update", id, `Updated product ${updated.name}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Product not found" });
  }
});

app.delete("/api/products/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.product.findUnique({ where: { id } });
    await prisma.product.delete({ where: { id } });
    logAudit("product_delete", id, `Deleted product ${existing?.name ?? "unknown"}`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Product not found" });
  }
});

// ── Orders (store checkout) ─────────────────────────────────────────────────

const VALID_ORDER_STATUSES = ["pending", "confirmed", "completed", "cancelled"];
const VALID_PAYMENT_METHODS = ["cash", "fawry", "instapay"];
const VALID_PAYMENT_STATUSES = ["unpaid", "proof_submitted", "paid"];

function fawryReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `PAW-${out}`;
}

app.get("/api/orders", async (_req, res) => {
  try {
    const orders = await prisma.order.findMany({ orderBy: { createdAt: "desc" } });
    res.json(orders);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

/** Public order lookup: must supply the order id AND the phone it was placed with. */
app.get("/api/orders/track", async (req, res) => {
  const { orderId, phone } = req.query;
  if (!orderId || !phone) {
    return res.status(400).json({ error: "orderId and phone are required" });
  }
  try {
    const order = await prisma.order.findFirst({
      where: { id: String(orderId), phone: String(phone).trim() },
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to look up order" });
  }
});

/**
 * Create an order. Stock is verified against the database and decremented
 * atomically inside a transaction, so two shoppers can never oversell.
 */
app.post("/api/orders", async (req, res) => {
  const body = req.body ?? {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return res.status(400).json({ error: "Cart is empty." });

  const paymentMethod = VALID_PAYMENT_METHODS.includes(String(body.paymentMethod ?? ""))
    ? String(body.paymentMethod)
    : "cash";

try {
     const created = await prisma.$transaction(async (tx) => {
       let total = 0;
       const lines = [];
       for (const item of items) {
         const id = String(item?.id ?? "");
         const qty = Number(item?.qty ?? 0);
         if (!id || !Number.isInteger(qty) || qty <= 0) {
           throw Object.assign(new Error("Invalid cart line."), { status: 400 });
         }
         const product = await tx.product.findUnique({ where: { id } });
         if (!product) {
           throw Object.assign(new Error(`Product ${id} no longer exists.`), { status: 400 });
         }
         if (product.stock < qty) {
           throw Object.assign(
             new Error(`${product.name} — only ${product.stock} left in stock.`),
             { status: 409 }
           );
         }
         const price = Number(product.price);
         total += price * qty;
         lines.push({ id, name: product.name, price, qty, image: product.image });
         await tx.product.update({
           where: { id },
           data: { stock: { decrement: qty } },
         });
       }
       total = Math.round(total * 100) / 100;

       const proofRef = String(body.paymentRef ?? "").trim();
       const proofImage = String(body.proofImage ?? "").trim();
       if (proofImage && proofImage.length > 5_500_000) {
         throw Object.assign(new Error("Proof image is too large (max 4 MB)."), { status: 400 });
       }
       const isInstaPay = paymentMethod === "instapay";
       const hasProof = Boolean(proofRef) || Boolean(proofImage);
       const paymentStatus =
         paymentMethod === "fawry"
           ? "unpaid"
           : isInstaPay && hasProof
             ? "proof_submitted"
             : "unpaid";

       return tx.order.create({
         data: {
           id: await nextId("ORD", "order"),
           customerName: String(body.customerName ?? ""),
           phone: String(body.phone ?? ""),
           email: String(body.email ?? ""),
           address: String(body.address ?? ""),
           items: lines,
           total,
           paymentMethod,
           paymentStatus,
           paymentRef: paymentMethod === "fawry" ? fawryReference() : proofRef,
           proofImage: isInstaPay ? proofImage : "",
         },
       });
     }, { timeout: 15000 });
     res.status(201).json(created);
   } catch (e) {
     if (e?.status === 400 || e?.status === 409) {
       return res.status(e.status).json({ error: e.message });
     }
     console.error(e);
     res.status(500).json({ error: "Failed to create order" });
   }
});

/** Submit/update payment proof (InstaPay ref + screenshot, or Fawry receipt number). */
app.post("/api/orders/:id/payment-proof", async (req, res) => {
  const { id } = req.params;
  const body = req.body ?? {};
  const paymentRef = String(body.paymentRef ?? "").trim();
  const proofImage = String(body.proofImage ?? "").trim();
  if (!paymentRef && !proofImage) {
    return res.status(400).json({ error: "Provide a transaction reference or a proof image." });
  }
  if (proofImage && proofImage.length > 5_500_000) {
    return res.status(400).json({ error: "Proof image is too large (max 4 MB)." });
  }
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Order not found" });
    if (existing.paymentStatus === "paid") {
      return res.status(400).json({ error: "This order is already marked as paid." });
    }
    const updated = await prisma.order.update({
      where: { id },
      data: {
        paymentRef: paymentRef || existing.paymentRef,
        proofImage: proofImage || existing.proofImage,
        paymentStatus: "proof_submitted",
      },
    });
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Order not found" });
  }
});

/** Staff only: mark an order as paid / unpaid. */
app.patch("/api/orders/:id/payment", async (req, res) => {
  const { id } = req.params;
  const { paymentStatus } = req.body ?? {};
  if (!VALID_PAYMENT_STATUSES.includes(paymentStatus)) {
    return res
      .status(400)
      .json({ error: `paymentStatus must be one of: ${VALID_PAYMENT_STATUSES.join(", ")}` });
  }
  try {
    const updated = await prisma.order.update({
      where: { id },
      data: {
        paymentStatus,
        paidAt: paymentStatus === "paid" ? new Date() : null,
      },
    });
    logAudit("order_payment", id, `Order ${updated.customerName} marked ${paymentStatus} (${updated.paymentMethod})`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Order not found" });
  }
});

app.patch("/api/orders/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body ?? {};
  if (!status || !VALID_ORDER_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: `status must be one of: ${VALID_ORDER_STATUSES.join(", ")}` });
  }
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Order not found" });

const updated = await prisma.$transaction(async (tx) => {
       // Return stock to the shelf when an order is cancelled.
       if (status === "cancelled" && existing.status !== "cancelled") {
         const lines = Array.isArray(existing.items) ? existing.items : [];
         for (const item of lines) {
           await tx.product.updateMany({
             where: { id: String(item?.id ?? "") },
             data: { stock: { increment: Number(item?.qty ?? 0) } },
           });
         }
       }
       return tx.order.update({ where: { id }, data: { status } });
     }, { timeout: 15000 });
     logAudit("order_status", id, `${existing.customerName}'s order → ${status}`);
     res.json(updated);
   } catch (e) {
     if (e?.status === 400 || e?.status === 409) {
       return res.status(e.status).json({ error: e.message });
     }
     console.error(e);
     res.status(500).json({ error: "Failed to update order status" });
   }
});

app.delete("/api/orders/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    await prisma.order.delete({ where: { id } });
    logAudit("order_delete", id, `Deleted order for ${existing?.customerName ?? "unknown"}`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Order not found" });
  }
});

/** Archive or restore an order (kept for records, hidden from active lists). */
app.patch("/api/orders/:id/archive", async (req, res) => {
  const { id } = req.params;
  const archived = req.body?.archived === true;
  try {
    const updated = await prisma.order.update({
      where: { id },
      data: { archived },
    });
    logAudit(archived ? "order_archive" : "order_restore", id, `${updated.customerName}'s order ${archived ? "archived" : "restored"}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Order not found" });
  }
});

// ── Payments ────────────────────────────────────────────────────────────────

/** Internal: all payment records, newest first. */
app.get("/api/payments", async (_req, res) => {
  try {
    const payments = await prisma.payment.findMany({ orderBy: { createdAt: "desc" } });
    res.json(payments);
  } catch {
    res.status(500).json({ error: "Failed to load payments" });
  }
});

/** Internal: create a manual payment record (in-clinic income, etc.). */
app.post("/api/payments", async (req, res) => {
  const body = req.body ?? {};
  const title = String(body.title ?? "").trim();
  const amount = Number(body.amount);
  const method = String(body.method ?? "cash");
  const status = String(body.status ?? "unpaid");
  const date = String(body.date ?? "").trim();
  if (!title || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "A title and a positive amount are required." });
  }
  if (!["cash", "fawry", "instapay"].includes(method)) {
    return res.status(400).json({ error: "Invalid payment method." });
  }
  if (!["unpaid", "paid"].includes(status)) {
    return res.status(400).json({ error: "status must be unpaid or paid." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD." });
  }
  try {
    const created = await prisma.payment.create({
      data: {
        id: await nextId("PAY", "payment"),
        title,
        amount: Math.round(amount * 100) / 100,
        method,
        status,
        date,
        notes: String(body.notes ?? "").trim(),
        orderId: String(body.orderId ?? "").trim(),
      },
    });
    logAudit("payment_create", created.id, `Recorded ${created.method} payment "${created.title}" (${created.status})`);
    res.status(201).json(created);
  } catch {
    res.status(500).json({ error: "Failed to create payment" });
  }
});

/** Internal: edit a payment record. */
app.patch("/api/payments/:id", async (req, res) => {
  const { id } = req.params;
  const body = req.body ?? {};
  const patch = {};
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return res.status(400).json({ error: "Title is required." });
    patch.title = title;
  }
  if (body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Amount must be positive." });
    }
    patch.amount = Math.round(amount * 100) / 100;
  }
  if (body.method !== undefined) {
    if (!["cash", "fawry", "instapay"].includes(String(body.method))) {
      return res.status(400).json({ error: "Invalid payment method." });
    }
    patch.method = String(body.method);
  }
  if (body.status !== undefined) {
    if (!["unpaid", "paid"].includes(String(body.status))) {
      return res.status(400).json({ error: "status must be unpaid or paid." });
    }
    patch.status = String(body.status);
  }
  if (body.date !== undefined) {
    const date = String(body.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD." });
    }
    patch.date = date;
  }
  if (body.notes !== undefined) patch.notes = String(body.notes).trim();
  if (body.orderId !== undefined) patch.orderId = String(body.orderId).trim();
  try {
    const updated = await prisma.payment.update({ where: { id }, data: patch });
    logAudit("payment_update", id, `Updated payment "${updated.title}"`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Payment not found" });
  }
});

/** Internal: permanently delete a payment record. */
app.delete("/api/payments/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.payment.findUnique({ where: { id } });
    await prisma.payment.delete({ where: { id } });
    logAudit("payment_delete", id, `Deleted payment "${existing?.title ?? "unknown"}"`);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Payment not found" });
  }
});

// ── Reviews ─────────────────────────────────────────────────────────────────

/** Public: approved reviews for one product. */
app.get("/api/products/:id/reviews", async (req, res) => {
  try {
    const reviews = await prisma.review.findMany({
      where: { productId: req.params.id, status: "approved" },
      orderBy: { createdAt: "desc" },
    });
    res.json(reviews);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

/** Admin: every review, pending ones first. */
app.get("/api/reviews", async (_req, res) => {
  try {
    const reviews = await prisma.review.findMany({ orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
    res.json(reviews);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch reviews" });
  }
});

/** Public: submit a review. It starts as `pending` until staff approves it. */
app.post("/api/reviews", async (req, res) => {
  const body = req.body ?? {};
  const rating = Number(body.rating ?? 0);
  const comment = String(body.comment ?? "").trim();
  const author = String(body.author ?? "").trim().slice(0, 80);
  const productId = String(body.productId ?? "");
  if (!productId) return res.status(400).json({ error: "productId is required" });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "rating must be a whole number between 1 and 5" });
  }
  if (!comment || comment.length < 4) {
    return res.status(400).json({ error: "comment must be at least 4 characters" });
  }
  if (!author) return res.status(400).json({ error: "author is required" });
  try {
    const created = await prisma.review.create({
      data: { productId, author, rating, comment, status: "pending" },
    });
    res.status(201).json(created);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create review" });
  }
});

/** Admin: approve or reject a review. */
app.patch("/api/reviews/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body ?? {};
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be approved or rejected" });
  }
  try {
    const updated = await prisma.review.update({ where: { id }, data: { status } });
    logAudit("review_status", id, `Review ${status}`);
    res.json(updated);
  } catch {
    res.status(404).json({ error: "Review not found" });
  }
});

app.delete("/api/reviews/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.review.delete({ where: { id } });
    res.status(204).send();
  } catch {
    res.status(404).json({ error: "Review not found" });
  }
});

// ── Settings ───────────────────────────────────────────────────────────────

app.get("/api/settings", async (_req, res) => {
  try {
    const settings = await prisma.clinicSettings.findUnique({ where: { id: 1 } });
    res.json(
      settings ?? {
        name: "Paw-M",
        tagline: "Veterinary care, quietly excellent.",
        phone: "",
        emergency: "",
        whatsapp: "",
        email: "",
        address: "",
        currency: "$",
        instapay: "",
      },
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

app.patch("/api/settings", async (req, res) => {
  const patch = req.body ?? {};
  const currency =
    patch.currency !== undefined ? String(patch.currency).trim().slice(0, 8) : undefined;
  if (currency !== undefined && currency.length === 0) {
    return res.status(400).json({ error: "Currency must not be empty." });
  }
  const instapay = patch.instapay !== undefined ? String(patch.instapay).trim().slice(0, 80) : undefined;
  try {
    const updated = await prisma.clinicSettings.upsert({
      where: { id: 1 },
      update: {
        name: patch.name !== undefined ? String(patch.name) : undefined,
        tagline: patch.tagline !== undefined ? String(patch.tagline) : undefined,
        phone: patch.phone !== undefined ? String(patch.phone) : undefined,
        emergency: patch.emergency !== undefined ? String(patch.emergency) : undefined,
        whatsapp: patch.whatsapp !== undefined ? String(patch.whatsapp) : undefined,
        email: patch.email !== undefined ? String(patch.email) : undefined,
        address: patch.address !== undefined ? String(patch.address) : undefined,
        currency: currency !== undefined ? currency : undefined,
        instapay: instapay !== undefined ? instapay : undefined,
      },
      create: {
        id: 1,
        name: patch.name ?? "Paw-M",
        tagline: patch.tagline ?? "",
        phone: patch.phone ?? "",
        emergency: patch.emergency ?? "",
        whatsapp: patch.whatsapp ?? "",
        email: patch.email ?? "",
        address: patch.address ?? "",
        currency: currency ?? "$",
        instapay: instapay ?? "",
      },
    });
    logAudit("settings_update", "", "Clinic settings updated");
    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

// ── Admin credentials auth ─────────────────────────────────────────────────

function hashPassword(password, salt) {
  return createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

const MIN_USERNAME = 3;
const MIN_PASSWORD = 6;

app.get("/api/auth/config", async (_req, res) => {
  try {
    const user = await prisma.adminUser.findFirst();
    res.json({ configured: Boolean(user) });
  } catch {
    res.status(500).json({ error: "Failed to check auth config" });
  }
});

/** First-run setup: create the staff account. Refuses once one exists. */
app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body ?? {};
  const name = String(username ?? "").trim().toLowerCase();
  const pass = String(password ?? "");
  if (name.length < MIN_USERNAME) {
    return res.status(400).json({ error: `Username must be at least ${MIN_USERNAME} characters.` });
  }
  if (pass.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }
  try {
    const existing = await prisma.adminUser.findFirst();
    if (existing) return res.status(409).json({ error: "Staff account already exists." });
    const salt = randomBytes(16).toString("hex");
    const hash = hashPassword(pass, salt);
    await prisma.adminUser.create({ data: { username: name, salt, hash } });
    res.json({ configured: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create staff account" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  const name = String(username ?? "").trim().toLowerCase();
  try {
    const user = await prisma.adminUser.findUnique({ where: { username: name } });
    if (!user) return res.json({ ok: false });
    const ok = hashPassword(String(password ?? ""), user.salt) === user.hash;
    if (ok) logAudit("login", "", `Staff sign-in: ${name}`);
    res.json({ ok });
  } catch {
    res.status(500).json({ error: "Failed to verify credentials" });
  }
});

/** Change the staff username and/or password. `currentPassword` must match. */
app.put("/api/auth/credentials", async (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body ?? {};
  const nextName = newUsername !== undefined ? String(newUsername).trim().toLowerCase() : undefined;
  const nextPass = newPassword !== undefined ? String(newPassword) : undefined;
  if (nextName !== undefined && nextName.length < MIN_USERNAME) {
    return res.status(400).json({ error: `Username must be at least ${MIN_USERNAME} characters.` });
  }
  if (nextPass !== undefined && nextPass.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.` });
  }
  if (nextName === undefined && nextPass === undefined) {
    return res.status(400).json({ error: "Nothing to change." });
  }
  try {
    const user = await prisma.adminUser.findFirst();
    if (!user) return res.status(404).json({ error: "No staff account configured." });
    const current = String(currentPassword ?? "");
    if (hashPassword(current, user.salt) !== user.hash) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
    const data = {};
    if (nextName !== undefined) data.username = nextName;
    if (nextPass !== undefined) {
      const salt = randomBytes(16).toString("hex");
      data.salt = salt;
      data.hash = hashPassword(nextPass, salt);
    }
    await prisma.adminUser.update({ where: { id: user.id }, data });
    logAudit("credentials_update", "", "Staff credentials changed");
    res.json({ configured: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update credentials" });
  }
});

app.listen(PORT, () => {
  console.log(`[Paw-M Backend] API running on http://localhost:${PORT}`);
});