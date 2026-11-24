import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function createTestUsers() {
  const users = [
    { username: 'test-staff', password: 'TestPass123!', role: 'staff' },
    { username: 'test-payroll', password: 'TestPass123!', role: 'payroll' },
    { username: 'test-admin', password: 'TestPass123!', role: 'admin' },
  ];

  for (const user of users) {
    const existing = await prisma.adminUser.findUnique({ where: { username: user.username } });
    if (existing) {
      console.log(`User ${user.username} already exists`);
      continue;
    }
    
    const salt = bcrypt.genSaltSync(12);
    const hash = bcrypt.hashSync(user.password, salt);
    
    await prisma.adminUser.create({
      data: {
        username: user.username,
        salt,
        hash,
        role: user.role,
        isActive: true,
      },
    });
    console.log(`Created user: ${user.username} (${user.role})`);
  }
  
  await prisma.$disconnect();
}

createTestUsers().catch(console.error);