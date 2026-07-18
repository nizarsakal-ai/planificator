-- CreateEnum
CREATE TYPE "AcquisitionSource" AS ENUM ('GMAIL');

-- CreateEnum
CREATE TYPE "AcquisitionMessageStatus" AS ENUM ('RECEIVED', 'ELIGIBLE', 'REJECTED', 'DRAFT_CREATED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "WorksiteImportDraftStatus" AS ENUM ('PENDING_EXTRACTION', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'CONVERTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AcquisitionAttachmentStatus" AS ENUM ('DISCOVERED', 'PENDING_DOWNLOAD', 'STORED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AcquisitionAttachmentCategory" AS ENUM ('PLAN', 'PHOTO', 'DOCUMENT', 'ARCHIVE', 'UNSUPPORTED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "acquisition_messages" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "source" "AcquisitionSource" NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "senderDomain" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "status" "AcquisitionMessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "processingAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "rawMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worksite_import_drafts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "acquisitionMessageId" TEXT NOT NULL,
    "status" "WorksiteImportDraftStatus" NOT NULL DEFAULT 'PENDING_EXTRACTION',
    "proposedClientId" TEXT,
    "proposedClientName" TEXT,
    "proposedWorksiteName" TEXT,
    "proposedAddress" TEXT,
    "proposedPostalCode" TEXT,
    "proposedCity" TEXT,
    "proposedContactName" TEXT,
    "proposedContactEmail" TEXT,
    "proposedContactPhone" TEXT,
    "proposedStartDate" TIMESTAMP(3),
    "proposedEndDate" TIMESTAMP(3),
    "proposedDescription" TEXT,
    "extractedData" JSONB,
    "confidenceData" JSONB,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdWorksiteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worksite_import_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acquisition_attachments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "acquisitionMessageId" TEXT NOT NULL,
    "attachmentKey" TEXT NOT NULL,
    "externalAttachmentId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "category" "AcquisitionAttachmentCategory" NOT NULL DEFAULT 'UNKNOWN',
    "status" "AcquisitionAttachmentStatus" NOT NULL DEFAULT 'DISCOVERED',
    "storageUrl" TEXT,
    "storagePublicId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "acquisition_messages_companyId_status_idx" ON "acquisition_messages"("companyId", "status");

-- CreateIndex
CREATE INDEX "acquisition_messages_companyId_receivedAt_idx" ON "acquisition_messages"("companyId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_messages_companyId_source_externalMessageId_key" ON "acquisition_messages"("companyId", "source", "externalMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_messages_id_companyId_key" ON "acquisition_messages"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_import_drafts_acquisitionMessageId_key" ON "worksite_import_drafts"("acquisitionMessageId");

-- CreateIndex
CREATE INDEX "worksite_import_drafts_companyId_status_idx" ON "worksite_import_drafts"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_import_drafts_acquisitionMessageId_companyId_key" ON "worksite_import_drafts"("acquisitionMessageId", "companyId");

-- CreateIndex
CREATE INDEX "acquisition_attachments_companyId_idx" ON "acquisition_attachments"("companyId");

-- CreateIndex
CREATE INDEX "acquisition_attachments_acquisitionMessageId_idx" ON "acquisition_attachments"("acquisitionMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_attachments_acquisitionMessageId_attachmentKey_key" ON "acquisition_attachments"("acquisitionMessageId", "attachmentKey");

-- AddForeignKey
ALTER TABLE "acquisition_messages" ADD CONSTRAINT "acquisition_messages_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worksite_import_drafts" ADD CONSTRAINT "worksite_import_drafts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worksite_import_drafts" ADD CONSTRAINT "worksite_import_drafts_acquisitionMessageId_companyId_fkey" FOREIGN KEY ("acquisitionMessageId", "companyId") REFERENCES "acquisition_messages"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worksite_import_drafts" ADD CONSTRAINT "worksite_import_drafts_proposedClientId_fkey" FOREIGN KEY ("proposedClientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worksite_import_drafts" ADD CONSTRAINT "worksite_import_drafts_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worksite_import_drafts" ADD CONSTRAINT "worksite_import_drafts_createdWorksiteId_fkey" FOREIGN KEY ("createdWorksiteId") REFERENCES "worksites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acquisition_attachments" ADD CONSTRAINT "acquisition_attachments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "acquisition_attachments" ADD CONSTRAINT "acquisition_attachments_acquisitionMessageId_companyId_fkey" FOREIGN KEY ("acquisitionMessageId", "companyId") REFERENCES "acquisition_messages"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
