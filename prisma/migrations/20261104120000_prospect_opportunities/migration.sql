-- Veille prospection (V1) — table des opportunités publiques (BOAMP, liste des festivals, DATAtourisme).
-- Additive uniquement : nouvelle table, aucune colonne ni contrainte modifiée sur les tables existantes.
-- NON appliquée en production : application manuelle après validation en préproduction, sur accord de Nizar.

-- CreateTable
CREATE TABLE "prospect_opportunities" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "organization" TEXT,
    "departmentCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locality" TEXT,
    "publishedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3),
    "eventStartAt" TIMESTAMP(3),
    "eventPeriod" TEXT,
    "url" TEXT,
    "winners" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linkedSourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "awardedTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "descriptors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alsoSeenIn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "score" INTEGER NOT NULL,
    "band" TEXT NOT NULL,
    "scoreReasons" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOUVEAU',
    "statusUpdatedAt" TIMESTAMP(3),
    "statusUpdatedById" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prospect_opportunities_companyId_kind_band_status_idx" ON "prospect_opportunities"("companyId", "kind", "band", "status");

-- CreateIndex
CREATE INDEX "prospect_opportunities_companyId_deadlineAt_idx" ON "prospect_opportunities"("companyId", "deadlineAt");

-- CreateIndex
CREATE INDEX "prospect_opportunities_companyId_fingerprint_idx" ON "prospect_opportunities"("companyId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "prospect_opportunities_companyId_source_sourceId_key" ON "prospect_opportunities"("companyId", "source", "sourceId");

-- AddForeignKey
ALTER TABLE "prospect_opportunities" ADD CONSTRAINT "prospect_opportunities_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

