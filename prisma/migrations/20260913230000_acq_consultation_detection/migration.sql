-- PLAN-ACQ-DETECTION-001 — Detection pré-extraction fail-closed (additif, sans backfill).
-- NULL = aucune preuve / historique inconnu → extraction AUTO bloquée.

CREATE TYPE "AcquisitionConsultationClassification" AS ENUM (
  'CONSULTATION',
  'CONSULTATION_UPDATE',
  'CANCELLATION',
  'NON_CONSULTATION',
  'AMBIGUOUS'
);

ALTER TABLE "worksite_import_drafts"
  ADD COLUMN "detectionClassification" "AcquisitionConsultationClassification",
  ADD COLUMN "detectionContentHash" TEXT,
  ADD COLUMN "detectionCompletedAt" TIMESTAMP(3),
  ADD COLUMN "extractionRetryable" BOOLEAN;
