-- CreateTable
CREATE TABLE "CashCustody" (
    "id" TEXT NOT NULL,
    "workSessionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "hasDrawer" BOOLEAN NOT NULL DEFAULT false,
    "openingAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashCustody_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashCustody_workSessionId_key" ON "CashCustody"("workSessionId");

-- CreateIndex
CREATE INDEX "CashCustody_employeeId_date_idx" ON "CashCustody"("employeeId", "date");

-- CreateIndex
CREATE INDEX "CashCustody_date_idx" ON "CashCustody"("date");

-- AddForeignKey
ALTER TABLE "CashCustody" ADD CONSTRAINT "CashCustody_workSessionId_fkey" FOREIGN KEY ("workSessionId") REFERENCES "WorkSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
