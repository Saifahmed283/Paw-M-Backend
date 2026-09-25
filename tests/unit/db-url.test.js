import { describe, it, expect } from "vitest";
import { buildDatabaseUrl } from "../../src/lib/db-url.js";

const FULL = {
  connectionLimit: 10,
  connectTimeoutSec: 10,
  poolTimeoutSec: 10,
  statementTimeoutMs: 15000,
  socketTimeoutSec: 30,
};

const queryOf = (url) => {
  const qs = url.slice(url.indexOf("?") + 1);
  return Object.fromEntries(qs.split("&").map((pair) => pair.split("=")));
};

describe("buildDatabaseUrl", () => {
  it("returns falsy input untouched so callers can rely on the result", () => {
    expect(buildDatabaseUrl(undefined, FULL)).toBeUndefined();
    expect(buildDatabaseUrl(null, FULL)).toBeNull();
    expect(buildDatabaseUrl("", FULL)).toBe("");
  });

  it("adds every timeout parameter when the url has no query string", () => {
    const result = buildDatabaseUrl("postgresql://u:p@host:5432/db", FULL);
    expect(result.startsWith("postgresql://u:p@host:5432/db?")).toBe(true);
    expect(queryOf(result)).toMatchObject({
      connection_limit: "10",
      connect_timeout: "10",
      pool_timeout: "10",
      socket_timeout: "30",
    });
  });

  it("routes statement_timeout through libpq options in milliseconds", () => {
    const { options } = queryOf(buildDatabaseUrl("postgresql://u:p@host:5432/db", FULL));
    expect(options).toBe("-c%20statement_timeout%3D15000");
  });

  it("does not emit statement_timeout as a top level parameter", () => {
    const result = buildDatabaseUrl("postgresql://u:p@host:5432/db", FULL);
    expect(result).not.toContain("statement_timeout=");
    expect(result).toContain("options=-c%20statement_timeout");
  });

  it("preserves existing parameters and appends with an ampersand", () => {
    const result = buildDatabaseUrl("postgresql://u:p@host:25060/db?sslmode=require", FULL);
    const qs = result.slice(result.indexOf("?") + 1);
    expect(qs.startsWith("sslmode=require&")).toBe(true);
    expect(queryOf(result).sslmode).toBe("require");
  });

  it("lets an operator override a default by specifying the parameter", () => {
    const result = buildDatabaseUrl(
      "postgresql://u:p@host:5432/db?connection_limit=99",
      FULL
    );
    const { connection_limit: value } = queryOf(result);
    expect(value).toBe("99");
    expect(result).not.toContain("connection_limit=10");
  });

  it("leaves an operator supplied options parameter alone", () => {
    const result = buildDatabaseUrl(
      "postgresql://u:p@host:5432/db?options=-c%20statement_timeout%3D999",
      FULL
    );
    expect(result.match(/options=/g)).toHaveLength(1);
    expect(result).toContain("statement_timeout%3D999");
  });

  it("omits non positive, non numeric and missing timeouts", () => {
    const result = buildDatabaseUrl("postgresql://u:p@host:5432/db", {
      connectionLimit: 0,
      connectTimeoutSec: -5,
      poolTimeoutSec: Number.NaN,
      statementTimeoutMs: undefined,
      socketTimeoutSec: Number.POSITIVE_INFINITY,
    });
    expect(result).toBe("postgresql://u:p@host:5432/db");
  });

  it("treats a missing timeouts object as no overrides", () => {
    expect(buildDatabaseUrl("postgresql://u:p@host:5432/db")).toBe(
      "postgresql://u:p@host:5432/db"
    );
  });

  it("never re-encodes credentials containing reserved characters", () => {
    const url = "postgresql://user:p@ss:w/rd@host:5432/db";
    const result = buildDatabaseUrl(url, FULL);
    expect(result.startsWith(url)).toBe(true);
  });
});
