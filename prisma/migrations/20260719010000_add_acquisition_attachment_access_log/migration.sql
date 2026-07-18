-- CreateEnum
CREATE TYPE "AcquisitionAttachmentAccessAction" AS ENUM ('VIEW', 'DOWNLOAD');

-- CreateEnum
CREATE TYPE "AcquisitionAttachmentAccessOutcome" AS ENUM ('GRANTED', 'DENIED');

-- CreateIndex (composite unique for access-log FK — id is already globally unique)
CREATE UNIQUE INDEX "acquisition_attachments_id_companyId_key" ON "acquisition_attachments"("id", "companyId");

-- CreateTable
CREATE TABLE "acquisition_attachment_access_logs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "attachmentId" TEXT,
    "requestedAttachmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" "AcquisitionAttachmentAccessAction" NOT NULL,
    "outcome" "AcquisitionAttachmentAccessOutcome" NOT NULL,
    "reasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acquisition_attachment_access_logs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "acquisition_attachment_access_logs" ADD CONSTRAINT "acquisition_attachment_access_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acquisition_attachment_access_logs" ADD CONSTRAINT "acquisition_attachment_access_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict : journal immuable — SetNull invalide (attachmentId nullable + companyId NOT NULL).
ALTER TABLE "acquisition_attachment_access_logs" ADD CONSTRAINT "acquisition_attachment_access_logs_attachmentId_companyId_fkey" FOREIGN KEY ("attachmentId", "companyId") REFERENCES "acquisition_attachments"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "acquisition_attachment_access_logs_companyId_createdAt_idx" ON "acquisition_attachment_access_logs"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "acquisition_attachment_access_logs_companyId_requestedAttac_idx" ON "acquisition_attachment_access_logs"("companyId", "requestedAttachmentId", "createdAt");

-- CreateIndex
CREATE INDEX "acquisition_attachment_access_logs_userId_createdAt_idx" ON "acquisition_attachment_access_logs"("userId", "createdAt");
