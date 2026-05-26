/*
  Warnings:

  - Added the required column `companyId` to the `absences` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "AbsenceType" ADD VALUE 'TRAINING';

-- AlterTable
ALTER TABLE "absences" ADD COLUMN     "companyId" TEXT NOT NULL,
ADD COLUMN     "createdById" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "name" TEXT;

-- CreateIndex
CREATE INDEX "absences_companyId_idx" ON "absences"("companyId");

-- AddForeignKey
ALTER TABLE "absences" ADD CONSTRAINT "absences_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
