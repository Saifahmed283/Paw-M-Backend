import { todayStr } from "./utils.js";

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** YYYY-MM-DD for the day after `dateKey`, without timezone drift. */
export function nextDateKey(dateKey) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * First UTC instant at which the clinic (Africa/Cairo) local date reaches
 * `dateKey`. Binary search keeps this correct across DST shifts.
 */
export function clinicDayStart(dateKey) {
  const guess = Date.parse(`${dateKey}T00:00:00Z`);
  let lo = guess - 24 * 60 * 60 * 1000;
  let hi = guess + 24 * 60 * 60 * 1000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (todayStr(new Date(mid)) < dateKey) lo = mid + 1;
    else hi = mid;
  }
  return new Date(lo);
}

export function clinicDayRange(dateKey) {
  return { start: clinicDayStart(dateKey), end: clinicDayStart(nextDateKey(dateKey)) };
}

/** Physical cash expected in the till for a Cairo clinic day. */
export async function expectedForDate(db, dateKey) {
  const { start, end } = clinicDayRange(dateKey);
  const aggregate = await db.paymentVerification.aggregate({
    _sum: { amount: true },
    where: {
      decision: "approved",
      source: "cash_reception",
      createdAt: { gte: start, lt: end },
    },
  });
  return round2(aggregate?._sum?.amount ?? 0);
}
