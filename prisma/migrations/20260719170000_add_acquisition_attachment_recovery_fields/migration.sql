-- PLAN-ACQ-004D : colonnes reclaim/retry + index (additif uniquement)

ALTER TABLE "acquisition_attachments"
  ADD COLUMN IF NOT EXISTS "downloadClaimedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "downloadRetryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "downloadNextRetryAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "acquisition_attachments_status_downloadClaimedAt_idx"
  ON "acquisition_attachments"("status", "downloadClaimedAt");

CREATE INDEX IF NOT EXISTS "acquisition_attachments_companyId_status_downloadNextRetryAt_idx"
  ON "acquisition_attachments"("companyId", "status", "downloadNextRetryAt");
