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

/**
 * Cash physically available for a clinic day.
 *
 * Once a drawer count is saved it is the source of truth: the till only holds
 * what was actually counted. Before a count, availability is opening cash plus
 * approved cash received. Pending withdrawals are reserved as well so several
 * staff cannot each spend the same balance.
 */
export async function cashAvailabilityForDate(
  db,
  dateKey,
  { includePending = true, excludeWithdrawalId = null } = {},
) {
  const close = await db.cashDrawerClose.findFirst({
    where: { date: dateKey },
    orderBy: { createdAt: "desc" },
  });

  const expected = close?.expected === null || close?.expected === undefined
    ? await expectedForDate(db, dateKey)
    : round2(close.expected);

  let openingAmount = 0;
  if ((close?.counted === null || close?.counted === undefined) && db.cashCustody?.findMany) {
    const custody = await db.cashCustody.findMany({
      where: { date: dateKey },
      select: { openingAmount: true },
    });
    openingAmount = round2(custody.reduce((sum, row) => sum + row.openingAmount, 0));
  }

  const base = close?.counted === null || close?.counted === undefined
    ? round2(openingAmount + expected)
    : round2(close.counted);

  const statuses = includePending ? ["pending", "approved"] : ["approved"];
  let reserved = 0;
  if (db.cashWithdrawal?.aggregate) {
    const aggregate = await db.cashWithdrawal.aggregate({
      _sum: { amount: true },
      where: {
        date: dateKey,
        status: { in: statuses },
        ...(excludeWithdrawalId ? { id: { not: excludeWithdrawalId } } : {}),
      },
    });
    reserved = round2(aggregate?._sum?.amount ?? 0);
  }

  return {
    available: round2(Math.max(0, base - reserved)),
    base,
    expected,
    counted: close?.counted ?? null,
    openingAmount,
    reserved,
    close: close ?? null,
  };
}
