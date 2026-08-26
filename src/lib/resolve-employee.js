import { prisma } from "./prisma.js";

/**
 * Given an AdminUser integer ID, resolve the matching Employee string ID.
 * AdminUser.username (e.g. "admin") maps to Employee.email (e.g. "admin@pawclinicmadinaty.com").
 */
export async function resolveEmployeeId(userId) {
  const adminUser = await prisma.adminUser.findUnique({ where: { id: userId }, select: { username: true } });
  if (!adminUser) return null;
  const employee = await prisma.employee.findFirst({
    where: { OR: [{ email: adminUser.username }, { email: { startsWith: adminUser.username + "@" } }] },
    select: { id: true },
  });
  return employee?.id ?? null;
}
