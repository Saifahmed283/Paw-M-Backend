/**
 * Backfill AdminUser.employeeId for accounts created before the explicit
 * AdminUser <-> Employee relation existed.
 *
 *   node scripts/backfill-account-employees.js            # dry run (default)
 *   node scripts/backfill-account-employees.js --apply    # write changes
 *
 * For each unlinked account: reuse the employee matched by the legacy
 * username -> email rule, or create the same companion employee used for new
 * accounts, then store the resulting id on the account.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { employeeEmailForUsername } from "../src/lib/employee-email.js";

export function defaultEmployeeEmail(username) {
  return employeeEmailForUsername(username);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Older companion employees got emails like "staff@pawm@paw-m.local" when the
 * username itself contained "@". Those records fail validation on every edit,
 * so repair them while the startup backfill runs.
 */
async function normalizeLinkedEmployeeEmails({ prisma, apply, log }) {
  if (typeof prisma.employee.findMany !== "function") return;
  const accounts = (await prisma.adminUser.findMany({
    where: { employeeId: { not: null } },
    select: { id: true, username: true, employeeId: true },
  })).filter((account) => account.employeeId);
  if (accounts.length === 0) return;

  const employees = await prisma.employee.findMany({
    where: { id: { in: accounts.map((a) => a.employeeId) } },
    select: { id: true, email: true },
  });
  const byId = new Map(employees.map((employee) => [employee.id, employee]));

  for (const account of accounts) {
    const employee = byId.get(account.employeeId);
    if (!employee || EMAIL_RE.test(employee.email ?? "")) continue;
    const email = employeeEmailForUsername(account.username);
    if (apply) await prisma.employee.update({ where: { id: employee.id }, data: { email } });
    log(`${apply ? "fixed" : "would fix"} employee email: ${employee.email} -> ${email}`);
  }
}

/** Legacy pairing rule: username -> Employee.email (exact or local part). */
export function legacyEmployeeWhere(username) {
  return { OR: [{ email: username }, { email: { startsWith: `${username}@` } }] };
}

export function companionEmployeeData(username, role) {
  return {
    fullName: username,
    email: defaultEmployeeEmail(username),
    role: role === "admin" ? "admin" : role === "payroll" ? "payroll" : "staff",
    isActive: true,
    payRateType: "hourly",
    hourlyRate: 0,
    monthlySalary: 0,
    roleHoursPerDay: 8,
    commissionRates: {},
  };
}

/** Persist the employee + link atomically when the client supports transactions. */
async function linkAccount(prisma, account, legacy, data) {
  const run = async (db) => {
    const employee =
      legacy ?? (await db.employee.create({ data, select: { id: true, email: true } }));
    await db.adminUser.update({ where: { id: account.id }, data: { employeeId: employee.id } });
    return employee;
  };
  return typeof prisma.$transaction === "function" ? prisma.$transaction((tx) => run(tx)) : run(prisma);
}

/**
 * @param {{ prisma: object, apply?: boolean, log?: (line: string) => void }} options
 * @returns {Promise<Array<{username: string, action: string, employeeId: string|null, email: string}>>}
 */
export async function backfillAccountEmployees({ prisma, apply = false, log = console.log } = {}) {
  if (!prisma) throw new Error("backfillAccountEmployees requires a prisma client");

  const accounts = await prisma.adminUser.findMany({
    where: { employeeId: null },
    select: { id: true, username: true, role: true, employeeId: true },
    orderBy: { id: "asc" },
  });

  const report = [];
  for (const account of accounts) {
    try {
      const legacy = await prisma.employee.findFirst({
        where: legacyEmployeeWhere(account.username),
        select: { id: true, email: true },
      });

      if (legacy) {
        if (apply) await linkAccount(prisma, account, legacy, null);
        report.push({
          username: account.username,
          action: apply ? "linked" : "would link",
          employeeId: legacy.id,
          email: legacy.email,
        });
        continue;
      }

      const data = companionEmployeeData(account.username, account.role);
      const employee = apply ? await linkAccount(prisma, account, null, data) : null;
      report.push({
        username: account.username,
        action: apply ? "created + linked" : "would create + link",
        employeeId: employee?.id ?? null,
        email: employee?.email ?? data.email,
      });
    } catch (err) {
      report.push({
        username: account.username,
        action: `failed: ${err.message}`,
        employeeId: null,
        email: "",
      });
    }
  }

  for (const row of report) {
    log(`${row.action.padEnd(20)} ${row.username} -> ${row.employeeId ?? "(new)"} (${row.email})`);
  }
  await normalizeLinkedEmployeeEmails({ prisma, apply, log });
  const failed = report.filter((r) => r.action.startsWith("failed")).length;
  log(
    `\n${apply ? "Applied" : "DRY RUN — no database writes"}: ${report.length - failed} of ${report.length} account(s) processed successfully.`,
  );
  if (!apply) log("Re-run with --apply to write the links.");
  return report;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    await backfillAccountEmployees({ prisma, apply });
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
