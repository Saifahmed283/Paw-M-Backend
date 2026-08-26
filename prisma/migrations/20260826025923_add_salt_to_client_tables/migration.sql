/*
  Warnings:

  - Added the required column `salt` to the `ClientAccount` table without a default value. This is not possible if the table is not empty.
  - Added the required column `salt` to the `ClientVerification` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "ClientAccount_email_idx";

-- AlterTable
ALTER TABLE "ClientAccount" ADD COLUMN     "salt" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ClientVerification" ADD COLUMN     "salt" TEXT NOT NULL;
