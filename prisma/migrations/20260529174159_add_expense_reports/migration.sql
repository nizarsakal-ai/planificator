-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('TRANSPORT', 'REPAS', 'HEBERGEMENT', 'MATERIEL', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'EXPENSE_REJECTED';

-- CreateTable
CREATE TABLE "expense_reports" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionNote" TEXT,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expense_reports_employeeId_idx" ON "expense_reports"("employeeId");

-- CreateIndex
CREATE INDEX "expense_reports_companyId_idx" ON "expense_reports"("companyId");

-- CreateIndex
CREATE INDEX "expense_reports_status_idx" ON "expense_reports"("status");

-- AddForeignKey
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
