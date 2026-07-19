-- PLAN-ACQ-005B-1 : extraction structurée — état EXTRACTING + colonnes draft (additif)

ALTER TYPE "WorksiteImportDraftStatus" ADD VALUE 'EXTRACTING';

ALTER TABLE "worksite_import_drafts" ADD COLUMN "warningData" JSONB,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "extractionStartedAt" TIMESTAMP(3),
ADD COLUMN "extractionCompletedAt" TIMESTAMP(3),
ADD COLUMN "contentHashAtExtraction" TEXT,
ADD COLUMN "extractionSchemaVersion" TEXT,
ADD COLUMN "extractionAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "extractionProvider" TEXT,
ADD COLUMN "extractionModel" TEXT,
ADD COLUMN "lastExtractionErrorCode" TEXT,
ADD COLUMN "lastExtractionErrorAt" TIMESTAMP(3);
