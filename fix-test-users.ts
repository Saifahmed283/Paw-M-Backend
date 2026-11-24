import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function fixTestUsers() {
  const users = [
    { username: 'test-staff', password: 'TestPass123!', role: 'staff' },
    { username: 'test-payroll', password: 'TestPass123!', role: 'payroll' },
    { username: 'test-admin', password: 'TestPass123!', role: 'admin' },
  ];

  for (const user of users) {
    // Find or create employee
    let employee = await prisma.employee.findFirst({ 
      where: { email: user.username + '@pawclinicmadinaty.com' } 
    });
    
    if (!employee) {
      employee = await prisma.employee.create({
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
      console.log(`Created employee for ${user.username}: ${employee.id}`);
    }
    
    // Update adminUser with employeeId
    await prisma.adminUser.update({
      where: { username: user.username },
      data: { employeeId: employee.id },
    });
    console.log(`Updated ${user.username} with employeeId: ${employee.id}`);
  }
  
  await prisma.$disconnect();
}

fixTestUsers().catch(console.error);