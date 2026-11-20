import { prisma } from "./prisma.js";

/**
 * Given an AdminUser integer ID, resolve the matching Employee string ID.
 *
 * Primary path: the explicit AdminUser.employeeId link (created for new accounts
 * and backfilled for existing ones). Fallback: the legacy username -> email rule
 * for accounts that have not been backfilled yet.
 */
export async function resolveEmployeeId(userId) {
  const adminUser = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: { username: true, employeeId: true },
  });
  if (!adminUser) return null;

  if (adminUser.employeeId) return adminUser.employeeId;

  const employee = await prisma.employee.findFirst({
    where: { OR: [{ email: adminUser.username }, { email: { startsWith: adminUser.username + "@" } }] },
    select: { id: true },
  });
  return employee?.id ?? null;
}
