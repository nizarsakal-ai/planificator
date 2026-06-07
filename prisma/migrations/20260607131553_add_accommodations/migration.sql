-- CreateEnum
CREATE TYPE "AccommodationStatus" AS ENUM ('UPCOMING', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'ACCOMMODATION_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'ACCOMMODATION_CANCELLED';

-- CreateTable
CREATE TABLE "accommodations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" "AccommodationStatus" NOT NULL DEFAULT 'UPCOMING',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT,
    "zipCode" TEXT,
    "doorCode" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accommodations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accommodations_companyId_idx" ON "accommodations"("companyId");

-- CreateIndex
CREATE INDEX "accommodations_teamId_idx" ON "accommodations"("teamId");

-- CreateIndex
CREATE INDEX "accommodations_startDate_idx" ON "accommodations"("startDate");

-- CreateIndex
CREATE INDEX "accommodations_status_idx" ON "accommodations"("status");

-- AddForeignKey
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
