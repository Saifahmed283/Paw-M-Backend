-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'store';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "discountLabel" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "Order_source_idx" ON "Order"("source");
