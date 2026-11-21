import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  backfillAccountEmployees,
  companionEmployeeData,
  defaultEmployeeEmail,
  legacyEmployeeWhere,
} from "../../scripts/backfill-account-employees.js";

const ACCOUNTS = [
  { id: 1, username: "admin", role: "admin", employeeId: null },
  { id: 2, username: "cashier", role: "staff", employeeId: null },
];

function makePrisma() {
  return {
    adminUser: {
      findMany: vi.fn().mockResolvedValue(ACCOUNTS),
      update: vi.fn().mockResolvedValue({}),
    },
    employee: {
      findFirst: vi.fn(async ({ where }) => {
        const username = where.OR[0].email;
        return username === "admin"
          ? { id: "emp-existing", email: "admin@pawclinicmadinaty.com" }
          : null;
      }),
      create: vi.fn().mockResolvedValue({
        id: "emp-new",
        email: "cashier@paw-m.local",
      }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("backfill-account-employees", () => {
  let prisma;
  let log;

  beforeEach(() => {
    prisma = makePrisma();
    log = vi.fn();
  });

  it("exposes the same companion employee shape used for new accounts", () => {
    expect(defaultEmployeeEmail("cashier")).toBe("cashier@paw-m.local");
    expect(defaultEmployeeEmail("ismail@pawm")).toBe("ismail.pawm@paw-m.local");
    expect(legacyEmployeeWhere("cashier")).toEqual({
      OR: [{ email: "cashier" }, { email: { startsWith: "cashier@" } }],
    });
    expect(companionEmployeeData("cashier", "payroll")).toMatchObject({
      email: "cashier@paw-m.local",
      role: "payroll",
      isActive: true,
    });
  });

  it("dry run reports planned links without writing anything", async () => {
    const report = await backfillAccountEmployees({ prisma, apply: false, log });

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { employeeId: null } }),
    );
    expect(report).toEqual([
      {
        username: "admin",
        action: "would link",
        employeeId: "emp-existing",
        email: "admin@pawclinicmadinaty.com",
      },
      {
        username: "cashier",
        action: "would create + link",
        employeeId: null,
        email: "cashier@paw-m.local",
      },
    ]);
    expect(prisma.employee.create).not.toHaveBeenCalled();
    expect(prisma.adminUser.update).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("admin -> emp-existing");
    expect(log.mock.calls.flat().join("\n")).toContain("DRY RUN");
  });

  it("--apply links legacy employees and creates missing companions", async () => {
    const report = await backfillAccountEmployees({ prisma, apply: true, log });

    expect(report.map((r) => r.action)).toEqual(["linked", "created + linked"]);
    expect(report[0]).toMatchObject({ username: "admin", employeeId: "emp-existing" });
    expect(report[1]).toMatchObject({ username: "cashier", employeeId: "emp-new" });
    expect(prisma.employee.create).toHaveBeenCalledTimes(1);
    expect(prisma.employee.create.mock.calls[0][0].data).toMatchObject({
      email: "cashier@paw-m.local",
      role: "staff",
    });
    expect(prisma.adminUser.update.mock.calls).toEqual([
      [{ where: { id: 1 }, data: { employeeId: "emp-existing" } }],
      [{ where: { id: 2 }, data: { employeeId: "emp-new" } }],
    ]);
  });

  it("uses a per-account transaction when the client supports it", async () => {
    prisma.$transaction = vi.fn(async (fn) => fn(prisma));

    await backfillAccountEmployees({ prisma, apply: true, log });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("isolates per-account failures and still reports the rest", async () => {
    prisma.adminUser.update.mockRejectedValueOnce(new Error("db unavailable"));
    const report = await backfillAccountEmployees({ prisma, apply: true, log });

    expect(report[0].action).toContain("failed:");
    expect(report[1].action).toBe("created + linked");
  });

  it("repairs malformed companion emails created from usernames containing @", async () => {
    prisma.adminUser.findMany.mockImplementation(({ where }) =>
      Promise.resolve(
        where?.employeeId === null
          ? ACCOUNTS
          : [{ id: 7, username: "ismail@pawm", role: "staff", employeeId: "emp-legacy" }],
      ),
    );
    prisma.employee.findMany.mockResolvedValueOnce([
      { id: "emp-legacy", email: "ismail@pawm@paw-m.local" },
    ]);

    await backfillAccountEmployees({ prisma, apply: true, log });

    expect(prisma.employee.update).toHaveBeenCalledWith({
      where: { id: "emp-legacy" },
      data: { email: "ismail.pawm@paw-m.local" },
    });
    expect(log.mock.calls.flat().join("\n")).toContain(
      "ismail@pawm@paw-m.local -> ismail.pawm@paw-m.local",
    );
  });
});
