import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function createTestStaff() {
  const users = [
    { username: 'test-staff', password: 'TestPass123!', role: 'staff' },
    { username: 'test-payroll', password: 'TestPass123!', role: 'payroll' },
  ];

  for (const user of users) {
    const existing = await prisma.adminUser.findUnique({ where: { username: user.username } });
    if (existing) {
      console.log(`User ${user.username} already exists, updating...`);
      // Ensure employeeId is set
      const emp = await prisma.employee.findFirst({ where: { email: user.username + '@pawclinicmadinaty.com' } });
      if (emp) {
        await prisma.adminUser.update({
          where: { username: user.username },
          data: { employeeId: emp.id, role: user.role, isActive: true },
        });
        console.log(`  Updated ${user.username} with employeeId: ${emp.id}`);
      }
      continue;
    }
    
    const salt = bcrypt.genSaltSync(12);
    const hash = bcrypt.hashSync(user.password, salt);
    
    // Create employee first
    const employee = await prisma.employee.create({
      data: {
        fullName: user.username,
        email: user.username + '@pawclinicmadinaty.com',
        role: user.role === 'admin' ? 'admin' : user.role === 'payroll' ? 'payroll' : 'staff',
        isActive: true,
        payRateType: 'hourly',
        hourlyRate: 0,
        monthlySalary: 0,
        roleHoursPerDay: 8,
        commissionRates: {},
      },
    });
    
    await prisma.adminUser.create({
      data: {
        username: user.username,
        salt,
        hash,
        role: user.role,
        isActive: true,
        employeeId: employee.id,
      },
    });
    console.log(`Created user: ${user.username} (${user.role}) with employeeId: ${employee.id}`);
  }
  
  await prisma.$disconnect();
}

createTestStaff().catch(console.error);