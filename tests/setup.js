import { vi } from "vitest";

const mockPrisma = {
  adminUser: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
  },
  booking: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  order: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
  },
  product: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  payment: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  paymentVerification: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    delete: vi.fn(),
  },
  cashDrawerClose: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  employee: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  workSession: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  cashCustody: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  },
  cashWithdrawal: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
  },
  payrollRecord: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
  },
  bonusDeductionRequest: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  stockMovement: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
  auditLog: {
    create: vi.fn().mockResolvedValue({}),
    findMany: vi.fn(),
  },
  review: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  clinicSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  doctor: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  service: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  adminTask: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  notification: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  $transaction: vi.fn(async (fns) => {
    if (typeof fns === "function") {
      return fns(mockPrisma);
    }
    return Promise.all(fns);
  }),
  $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]),
  $queryRawUnsafe: vi.fn().mockResolvedValue([{ ok: 1 }]),
  $connect: vi.fn().mockResolvedValue(undefined),
  $disconnect: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../src/lib/prisma.js", () => ({
  prisma: mockPrisma,
}));

export { mockPrisma };
