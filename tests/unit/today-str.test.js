import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../../src/lib/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

import { todayStr } from "../../src/lib/utils.js";

describe("todayStr (clinic-local day key)", () => {
  it("uses Africa/Cairo, not the UTC calendar day (winter, UTC+2)", () => {
    const instant = new Date("2026-01-30T22:30:00.000Z");
    expect(instant.toISOString().slice(0, 10)).toBe("2026-01-30");
    expect(todayStr(instant)).toBe("2026-01-31");
  });

  it("uses Africa/Cairo across midnight in summer (EEST, UTC+3)", () => {
    const before = new Date("2026-06-30T20:59:00.000Z");
    const after = new Date("2026-06-30T21:01:00.000Z");
    expect(todayStr(before)).toBe("2026-06-30");
    expect(todayStr(after)).toBe("2026-07-01");
  });

  it("formats an ordinary midday as YYYY-MM-DD", () => {
    expect(todayStr(new Date("2026-11-20T12:00:00.000Z"))).toBe("2026-11-20");
  });
});
