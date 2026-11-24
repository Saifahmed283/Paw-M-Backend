import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function check() {
  const users = await prisma.adminUser.findMany({
    where: { username: { in: ['test-staff', 'test-payroll', 'test-admin'] } },
    select: { username: true, role: true, isActive: true, employeeId: true }
  });
  console.log(users);
  await prisma.$disconnect();
}

check().catch(console.error);