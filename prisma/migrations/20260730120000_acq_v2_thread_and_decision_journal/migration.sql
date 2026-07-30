-- PLAN-ACQ-V2 Lot H — threadId indexé sur acquisition_messages
-- Backfill depuis rawMetadata->>'threadId' quand présent.

ALTER TABLE "acquisition_messages" ADD COLUMN IF NOT EXISTS "threadId" TEXT;

UPDATE "acquisition_messages"
SET "threadId" = NULLIF(TRIM("rawMetadata"->>'threadId'), '')
WHERE "threadId" IS NULL
  AND "rawMetadata" IS NOT NULL
  AND "rawMetadata"->>'threadId' IS NOT NULL;

CREATE INDEX IF NOT EXISTS "acquisition_messages_companyId_threadId_idx"
  ON "acquisition_messages"("companyId", "threadId");

-- PLAN-ACQ-V2 Lot F — journal décisions auto

CREATE TABLE IF NOT EXISTS "acquisition_decision_journals" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "decisionCode" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "scores" JSONB NOT NULL,
    "actorUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acquisition_decision_journals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "acquisition_decision_journals_companyId_createdAt_idx"
  ON "acquisition_decision_journals"("companyId", "createdAt");

CREATE INDEX IF NOT EXISTS "acquisition_decision_journals_companyId_draftId_idx"
  ON "acquisition_decision_journals"("companyId", "draftId");

CREATE INDEX IF NOT EXISTS "acquisition_decision_journals_companyId_decisionCode_idx"
  ON "acquisition_decision_journals"("companyId", "decisionCode");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'acquisition_decision_journals_companyId_fkey'
  ) THEN
    ALTER TABLE "acquisition_decision_journals"
      ADD CONSTRAINT "acquisition_decision_journals_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
