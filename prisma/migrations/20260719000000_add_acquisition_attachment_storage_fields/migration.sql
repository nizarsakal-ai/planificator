-- AlterTable
ALTER TABLE "acquisition_attachments" ADD COLUMN "sha256" TEXT,
ADD COLUMN "storedAt" TIMESTAMP(3),
ADD COLUMN "lastErrorCode" TEXT,
ADD COLUMN "lastErrorAt" TIMESTAMP(3);
