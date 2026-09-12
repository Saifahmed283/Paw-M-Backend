-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "diagnosis" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "followUpDate" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "petId" TEXT,
ADD COLUMN     "treatmentNotes" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "ClinicSettings" ADD COLUMN     "rolePermissions" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Doctor" ADD COLUMN     "licenseNumber" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "signatureImage" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "title" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "barcodeImage" TEXT DEFAULT '';

-- CreateTable
CREATE TABLE "Pet" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "species" TEXT NOT NULL,
    "breed" TEXT NOT NULL DEFAULT '',
    "sex" TEXT NOT NULL DEFAULT '',
    "dob" TEXT NOT NULL DEFAULT '',
    "weightKg" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '',
    "microchip" TEXT NOT NULL DEFAULT '',
    "photo" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prescription" (
    "id" TEXT NOT NULL,
    "rxNumber" TEXT NOT NULL,
    "verifyCode" TEXT NOT NULL,
    "petId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "bookingId" TEXT,
    "diagnosis" TEXT NOT NULL DEFAULT '',
    "items" JSONB NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "followUpDate" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'issued',
    "issuedAt" TIMESTAMP(3),
    "signatureSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prescription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Pet_clientId_idx" ON "Pet"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Prescription_rxNumber_key" ON "Prescription"("rxNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Prescription_verifyCode_key" ON "Prescription"("verifyCode");

-- CreateIndex
CREATE INDEX "Prescription_petId_idx" ON "Prescription"("petId");

-- CreateIndex
CREATE INDEX "Prescription_clientId_idx" ON "Prescription"("clientId");

-- CreateIndex
CREATE INDEX "Prescription_doctorId_idx" ON "Prescription"("doctorId");

-- CreateIndex
CREATE INDEX "Prescription_status_idx" ON "Prescription"("status");

-- CreateIndex
CREATE INDEX "Booking_clientId_idx" ON "Booking"("clientId");

-- CreateIndex
CREATE INDEX "Booking_petId_idx" ON "Booking"("petId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ClientAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_petId_fkey" FOREIGN KEY ("petId") REFERENCES "Pet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ClientAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pet" ADD CONSTRAINT "Pet_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ClientAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_petId_fkey" FOREIGN KEY ("petId") REFERENCES "Pet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ClientAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

