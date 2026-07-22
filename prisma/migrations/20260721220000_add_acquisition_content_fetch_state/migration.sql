-- PLAN-ACQ-OPS-003 : état retry / poison pill du fetch content (additif uniquement)

CREATE TABLE "acquisition_content_fetch_states" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "acquisitionMessageId" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "terminalAt" TIMESTAMP(3),
    "previousTerminalAt" TIMESTAMP(3),
    "previousTerminalErrorCode" TEXT,
    "reactivatedAt" TIMESTAMP(3),
    "reactivatedBy" TEXT,
    "reactivationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_content_fetch_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "acquisition_content_fetch_states_acquisitionMessageId_key"
  ON "acquisition_content_fetch_states"("acquisitionMessageId");

CREATE UNIQUE INDEX "acquisition_content_fetch_states_acquisitionMessageId_companyId_key"
  ON "acquisition_content_fetch_states"("acquisitionMessageId", "companyId");

CREATE INDEX "acquisition_content_fetch_states_companyId_terminalAt_nextRetryAt_idx"
  ON "acquisition_content_fetch_states"("companyId", "terminalAt", "nextRetryAt");

ALTER TABLE "acquisition_content_fetch_states"
  ADD CONSTRAINT "acquisition_content_fetch_states_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "acquisition_content_fetch_states"
  ADD CONSTRAINT "acquisition_content_fetch_states_acquisitionMessageId_companyId_fkey"
  FOREIGN KEY ("acquisitionMessageId", "companyId")
  REFERENCES "acquisition_messages"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
