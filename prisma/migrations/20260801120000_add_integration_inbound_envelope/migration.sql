-- PLAN-INTEGRATION-PLATFORM-001 — LOT-1B2
-- Persistance InboundEnvelope + NormalizedInbound (additif uniquement).
-- Convention colonnes camelCase — alignée LOT-1B1.
-- Aucun ALTER destructif sur integration_connections.

-- ── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "EnvelopeLifecycleStatus" AS ENUM (
    'RECEIVED',
    'NORMALIZED',
    'NORMALIZE_FAILED',
    'ROUTED',
    'NO_MATCH',
    'AMBIGUOUS',
    'DISPATCHED',
    'DISCARDED',
    'ARCHIVED'
);

CREATE TYPE "InboundFamily" AS ENUM (
    'MESSAGE'
);

-- ── InboundEnvelope ─────────────────────────────────────────────────────────

CREATE TABLE "integration_inbound_envelopes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "connectorType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "payloadRef" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "lifecycleStatus" "EnvelopeLifecycleStatus" NOT NULL DEFAULT 'RECEIVED',
    "rawPayloadHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_inbound_envelopes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_inbound_envelopes_id_companyId_key"
  ON "integration_inbound_envelopes"("id", "companyId");

CREATE UNIQUE INDEX "integration_inbound_envelopes_id_companyId_connectionId_key"
  ON "integration_inbound_envelopes"("id", "companyId", "connectionId");

CREATE UNIQUE INDEX "integration_inbound_envelopes_idempotency_key"
  ON "integration_inbound_envelopes"("companyId", "connectionId", "idempotencyKey");

CREATE INDEX "integration_inbound_envelopes_companyId_lifecycleStatus_idx"
  ON "integration_inbound_envelopes"("companyId", "lifecycleStatus");

-- Noms raccourcis ≤63 octets (limite identifiant PostgreSQL) — colonnes inchangées (SPEC §3.4)
CREATE INDEX "integration_inbound_envelopes_co_conn_receivedAt_idx"
  ON "integration_inbound_envelopes"("companyId", "connectionId", "receivedAt");

CREATE INDEX "integration_inbound_envelopes_co_conn_externalId_idx"
  ON "integration_inbound_envelopes"("companyId", "connectionId", "externalId");

ALTER TABLE "integration_inbound_envelopes"
  ADD CONSTRAINT "integration_inbound_envelopes_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_inbound_envelopes"
  ADD CONSTRAINT "integration_inbound_envelopes_connectionId_companyId_fkey"
  FOREIGN KEY ("connectionId", "companyId")
  REFERENCES "integration_connections"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── NormalizedInbound ───────────────────────────────────────────────────────

CREATE TABLE "integration_normalized_inbounds" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "family" "InboundFamily" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "normalizedHash" TEXT NOT NULL,
    "artifactRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "schemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "message" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_normalized_inbounds_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_normalized_inbounds_id_companyId_key"
  ON "integration_normalized_inbounds"("id", "companyId");

CREATE UNIQUE INDEX "integration_normalized_inbounds_envelope_version_key"
  ON "integration_normalized_inbounds"("envelopeId", "companyId", "family", "schemaVersion");

-- Nom raccourci ≤63 octets — colonnes inchangées (SPEC §4.4)
CREATE INDEX "integration_normalized_inbounds_co_conn_receivedAt_idx"
  ON "integration_normalized_inbounds"("companyId", "connectionId", "receivedAt");

CREATE INDEX "integration_normalized_inbounds_companyId_envelopeId_idx"
  ON "integration_normalized_inbounds"("companyId", "envelopeId");

ALTER TABLE "integration_normalized_inbounds"
  ADD CONSTRAINT "integration_normalized_inbounds_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_normalized_inbounds"
  ADD CONSTRAINT "integration_normalized_inbounds_envelope_tenant_connection_fkey"
  FOREIGN KEY ("envelopeId", "companyId", "connectionId")
  REFERENCES "integration_inbound_envelopes"("id", "companyId", "connectionId")
  ON DELETE CASCADE ON UPDATE CASCADE;
