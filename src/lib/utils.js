import { randomBytes } from "node:crypto";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "utils" });

const CLINIC_TIME_ZONE = "Africa/Cairo";

/** Day key used by work sessions / work days / payments, in the clinic's local time. */
export function todayStr(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CLINIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const part = (type) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function cryptoRandomInt(max) {
  const bytesNeeded = Math.ceil(Math.log2(max) / 8);
  const maxVal = 256 ** bytesNeeded;
  const threshold = maxVal - (maxVal % max);
  let rand;
  do {
    rand = randomBytes(bytesNeeded).readUIntBE(0, bytesNeeded);
  } while (rand >= threshold);
  return (rand % max) + 1;
}

function shortCode(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    const idx = Math.floor(cryptoRandomInt(alphabet.length)) - 1;
    out += alphabet[idx >= 0 ? idx : 0];
  }
  return out;
}

export async function nextId(prefix, model) {
  for (let i = 0; i < 6; i++) {
    const id = `${prefix}-${shortCode(6)}`;
    const exists = await prisma[model].findUnique({ where: { id } });
    if (!exists) return id;
  }
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

export function logAudit(action, target = "", detail = "") {
  prisma.auditLog
    .create({
      data: {
        action: String(action).slice(0, 80),
        target: String(target).slice(0, 120),
        detail: String(detail).slice(0, 400),
      },
    })
    .catch((e) => log.error({ err: e }, "audit log failed"));
}

export async function archiveFinishedDayRecords() {
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
  for (const b of bookings)
    logAudit("auto_archive", b.id, "Booking auto-archived at shift end");
  for (const o of orders)
    logAudit("auto_archive", o.id, "Order auto-archived at shift end");
  return { bookings: bookings.length, orders: orders.length };
}

export const VALID_STATUSES = ["pending", "confirmed", "completed", "cancelled"];
export const VALID_ORDER_STATUSES = ["pending", "confirmed", "completed", "cancelled"];
export const VALID_PAYMENT_METHODS = ["cash", "fawry", "instapay"];
export const VALID_PAYMENT_STATUSES = ["unpaid", "proof_submitted", "under_review", "paid", "rejected"];
export const VALID_PET_TYPES = ["dog", "cat", "both"];

export function sanitizePetType(value) {
  return VALID_PET_TYPES.includes(value) ? value : "both";
}

export function isValidBase64Image(dataUrl) {
  if (typeof dataUrl !== "string") return false;
  const prefix = "data:image/";
  if (!dataUrl.startsWith(prefix)) return false;
  const semicolon = dataUrl.indexOf(";", prefix.length);
  if (semicolon === -1) return false;
  const encoding = dataUrl.slice(prefix.length, semicolon);
  if (!["base64", "jpeg", "png", "webp", "gif", "bmp"].includes(encoding)) return false;
  const base64 = dataUrl.slice(semicolon + 1);
  if (!base64.startsWith("base64,")) return false;
  return true;
}

export function getBase64ByteLength(dataUrl) {
  if (!isValidBase64Image(dataUrl)) return 0;
  const base64 = dataUrl.split(",")[1] ?? "";
  const padding = (base64.match(/=/g) ?? []).length;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function fawryReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[cryptoRandomInt(alphabet.length) - 1];
  return `PAW-${out}`;
}

export function withTimeout(promise, ms, label = "operation") {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return promise;

  let timer;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}
