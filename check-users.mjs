import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
p.adminUser.findMany()
  .then(users => {
    console.log("Admin users count:", users.length);
    return p.$disconnect();
  })
  .catch(e => { console.error(e); p.$disconnect(); process.exit(1); });