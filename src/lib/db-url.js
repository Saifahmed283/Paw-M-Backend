const SECOND_BASED_PARAMS = [
  ["connection_limit", "connectionLimit"],
  ["connect_timeout", "connectTimeoutSec"],
  ["pool_timeout", "poolTimeoutSec"],
  ["socket_timeout", "socketTimeoutSec"],
];

function isPositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Adds connection-pool and query timeouts to a PostgreSQL connection string.
 *
 * Units differ by parameter, and the difference is not cosmetic:
 *   - connect_timeout / pool_timeout / socket_timeout are seconds
 *   - statement_timeout is milliseconds, and only when routed through libpq's
 *     `options` passthrough — Prisma silently ignores it as a top-level DSN
 *     parameter. Verified against PostgreSQL 18.6: a top-level
 *     `statement_timeout=3` let a 5s query run to completion, while
 *     `options=-c%20statement_timeout%3D3000` aborted it server-side.
 *
 * The URL is split manually rather than via `new URL()` so credentials
 * containing reserved characters (e.g. `@` or `/` in a password) survive
 * untouched instead of being re-encoded. Any parameter already present in
 * DATABASE_URL wins, so an operator can always override the defaults.
 */
export function buildDatabaseUrl(url, timeouts = {}) {
  if (!url) return url;

  const queryIndex = url.indexOf("?");
  const base = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const existingQuery = queryIndex === -1 ? "" : url.slice(queryIndex + 1);

  const present = new Set(
    existingQuery.split("&").filter(Boolean).map((pair) => pair.split("=")[0].trim())
  );

  const added = [];

  for (const [param, key] of SECOND_BASED_PARAMS) {
    if (!isPositive(timeouts[key]) || present.has(param)) continue;
    added.push(`${param}=${timeouts[key]}`);
  }

  if (isPositive(timeouts.statementTimeoutMs) && !present.has("options")) {
    added.push(`options=-c%20statement_timeout%3D${timeouts.statementTimeoutMs}`);
  }

  if (added.length === 0) return url;

  return `${base}?${[existingQuery, ...added].filter(Boolean).join("&")}`;
}
