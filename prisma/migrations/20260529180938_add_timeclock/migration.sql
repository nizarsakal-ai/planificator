-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'TIMECLOCK_IN';
ALTER TYPE "NotificationType" ADD VALUE 'TIMECLOCK_OUT';

-- CreateTable
CREATE TABLE "timeclocks" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "worksiteId" TEXT,
    "date" DATE NOT NULL,
    "checkInAt" TIMESTAMP(3),
    "checkInLat" DOUBLE PRECISION,
    "checkInLng" DOUBLE PRECISION,
    "checkOutAt" TIMESTAMP(3),
    "checkOutLat" DOUBLE PRECISION,
    "checkOutLng" DOUBLE PRECISION,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timeclocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "timeclocks_employeeId_idx" ON "timeclocks"("employeeId");

-- CreateIndex
CREATE INDEX "timeclocks_companyId_idx" ON "timeclocks"("companyId");

-- CreateIndex
CREATE INDEX "timeclocks_date_idx" ON "timeclocks"("date");

-- CreateIndex
CREATE UNIQUE INDEX "timeclocks_employeeId_date_key" ON "timeclocks"("employeeId", "date");

-- AddForeignKey
ALTER TABLE "timeclocks" ADD CONSTRAINT "timeclocks_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeclocks" ADD CONSTRAINT "timeclocks_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeclocks" ADD CONSTRAINT "timeclocks_worksiteId_fkey" FOREIGN KEY ("worksiteId") REFERENCES "worksites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
