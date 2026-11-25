-- Cash withdrawals: staff request cash from the till, admin approves or rejects.
-- Availability is derived from the day's counted/expected cash minus approved
-- withdrawals, so no balance column needs to be kept in sync here.

-- CreateTable
CREATE TABLE "CashWithdrawal" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "note" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedBy" INTEGER NOT NULL,
    "employeeId" TEXT,
    "workSessionId" TEXT,
    "reviewedBy" INTEGER,
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashWithdrawal_date_status_idx" ON "CashWithdrawal"("date", "status");

-- CreateIndex
CREATE INDEX "CashWithdrawal_requestedBy_idx" ON "CashWithdrawal"("requestedBy");

-- AddForeignKey
ALTER TABLE "CashWithdrawal" ADD CONSTRAINT "CashWithdrawal_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashWithdrawal" ADD CONSTRAINT "CashWithdrawal_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
