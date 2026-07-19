-- PLAN-ACQ-005A : contenu email normalisé (additif uniquement)
-- Aucune colonne truncated : contenu trop volumineux = refus, pas de coupe.

CREATE TABLE "acquisition_message_contents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "acquisitionMessageId" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceMimeType" TEXT,
    "sourceCharset" TEXT,
    "hadHtml" BOOLEAN NOT NULL DEFAULT false,
    "byteLengthOriginal" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "sanitizedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_message_contents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "acquisition_message_contents_acquisitionMessageId_key"
  ON "acquisition_message_contents"("acquisitionMessageId");

CREATE UNIQUE INDEX "acquisition_message_contents_acquisitionMessageId_companyId_key"
  ON "acquisition_message_contents"("acquisitionMessageId", "companyId");

CREATE INDEX "acquisition_message_contents_companyId_idx"
  ON "acquisition_message_contents"("companyId");

ALTER TABLE "acquisition_message_contents"
  ADD CONSTRAINT "acquisition_message_contents_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "acquisition_message_contents"
  ADD CONSTRAINT "acquisition_message_contents_acquisitionMessageId_companyId_fkey"
  FOREIGN KEY ("acquisitionMessageId", "companyId")
  REFERENCES "acquisition_messages"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
