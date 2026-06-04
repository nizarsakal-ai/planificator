-- AlterEnum
ALTER TYPE "WorksiteStatus" ADD VALUE 'DELAYED';

-- AlterTable
ALTER TABLE "worksites" ADD COLUMN     "delayedUntil" TIMESTAMP(3);
