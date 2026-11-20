-- Secure payment verification: trusted events only may settle an order.
--
-- ALTER TYPE ... ADD VALUE is intentionally kept at the top and uses IF NOT
-- EXISTS. Older PostgreSQL versions forbid *using* a newly added enum value in
-- the same transaction, so no statement below references 'under_review' or
-- 'rejected' as a value. PaymentVerification.decision is TEXT for that reason.

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'under_review';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'rejected';

-- CreateTable
CREATE TABLE "PaymentVerification" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT,
    "method" "PaymentMethod" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "customerRef" TEXT NOT NULL DEFAULT '',
    "senderName" TEXT NOT NULL DEFAULT '',
    "transferredAt" TIMESTAMP(3),
    "evidenceKey" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "decision" TEXT NOT NULL DEFAULT 'submitted',
    "bankTransactionReference" TEXT,
    "reviewerId" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashDrawerClose" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "expected" DOUBLE PRECISION NOT NULL,
    "counted" DOUBLE PRECISION NOT NULL,
    "variance" DOUBLE PRECISION NOT NULL,
    "countedBy" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashDrawerClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentVerification_orderId_idx" ON "PaymentVerification"("orderId");

-- CreateIndex
CREATE INDEX "PaymentVerification_decision_idx" ON "PaymentVerification"("decision");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentVerification_bankTransactionReference_key" ON "PaymentVerification"("bankTransactionReference");

-- CreateIndex
CREATE INDEX "CashDrawerClose_date_idx" ON "CashDrawerClose"("date");

-- AddForeignKey
ALTER TABLE "PaymentVerification" ADD CONSTRAINT "PaymentVerification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentVerification" ADD CONSTRAINT "PaymentVerification_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashDrawerClose" ADD CONSTRAINT "CashDrawerClose_countedBy_fkey" FOREIGN KEY ("countedBy") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
