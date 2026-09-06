-- PLAN-ACQ-CONSULTATION-TEMPORAL-POLICY-IMPL-007 — OBSOLETE + clientConsultationDate
-- Structure only ; no historical backfill.
ALTER TYPE "WorksiteImportDraftStatus" ADD VALUE 'OBSOLETE';
ALTER TABLE "worksite_import_drafts" ADD COLUMN "clientConsultationDate" TIMESTAMP(3);
