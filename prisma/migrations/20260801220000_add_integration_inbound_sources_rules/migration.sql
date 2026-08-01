-- PLAN-INTEGRATION-PLATFORM-001 — LOT-2A
-- Persistance InboundSource + InboundSourceRule (additif uniquement).
-- Convention colonnes camelCase — alignée LOT-1B1/1B2.
-- Aucun ALTER destructif sur LOT-1B/1C.

-- ── Enum ────────────────────────────────────────────────────────────────────

CREATE TYPE "InboundSourceRuleType" AS ENUM (
    'SENDER_EMAIL',
    'SENDER_DOMAIN',
    'SUBJECT_KEYWORD',
    'BODY_KEYWORD',
    'RECIPIENT_EMAIL'
);

-- ── InboundSource ───────────────────────────────────────────────────────────

CREATE TABLE "integration_inbound_sources" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "schemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_inbound_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_inbound_sources_id_companyId_key"
  ON "integration_inbound_sources"("id", "companyId");

CREATE INDEX "integration_inbound_sources_companyId_enabled_idx"
  ON "integration_inbound_sources"("companyId", "enabled");

ALTER TABLE "integration_inbound_sources"
  ADD CONSTRAINT "integration_inbound_sources_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── InboundSourceRule ───────────────────────────────────────────────────────

CREATE TABLE "integration_inbound_source_rules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "type" "InboundSourceRuleType" NOT NULL,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "schemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_inbound_source_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_inbound_source_rules_id_companyId_key"
  ON "integration_inbound_source_rules"("id", "companyId");

CREATE UNIQUE INDEX "integration_inbound_source_rules_match_key"
  ON "integration_inbound_source_rules"("companyId", "sourceId", "type", "normalizedValue");

CREATE INDEX "integration_inbound_source_rules_co_type_norm_idx"
  ON "integration_inbound_source_rules"("companyId", "type", "normalizedValue");

CREATE INDEX "integration_inbound_source_rules_co_src_en_idx"
  ON "integration_inbound_source_rules"("companyId", "sourceId", "enabled");

ALTER TABLE "integration_inbound_source_rules"
  ADD CONSTRAINT "integration_inbound_source_rules_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_inbound_source_rules"
  ADD CONSTRAINT "integration_inbound_source_rules_source_fkey"
  FOREIGN KEY ("sourceId", "companyId")
  REFERENCES "integration_inbound_sources"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
