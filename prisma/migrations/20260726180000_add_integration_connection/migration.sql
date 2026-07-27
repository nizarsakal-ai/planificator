-- PLAN-INTEGRATION-PLATFORM-001 — LOT-1B1
-- Persistance IntegrationConnection (additif uniquement).
-- Méthode : SQL rédigé manuellement (aligné conventions dépôt) — pas de
-- `prisma migrate dev` contre une base partagée / non confirmée.
-- Aucun seed. Aucune valeur ConnectorType concrète. Aucune FK Booking/ACQ.

-- ── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "IntegrationConnectionStatus" AS ENUM (
    'PENDING_AUTH',
    'ACTIVE',
    'DISABLED',
    'ERROR',
    'ARCHIVED'
);

CREATE TYPE "IntegrationCredentialStatus" AS ENUM (
    'MISSING',
    'PENDING',
    'ACTIVE',
    'EXPIRED',
    'REVOKED',
    'RETIRED',
    'FAILED'
);

CREATE TYPE "IntegrationRuntimeHealth" AS ENUM (
    'UNKNOWN',
    'HEALTHY',
    'DEGRADED',
    'UNHEALTHY'
);

CREATE TYPE "IntegrationSecretBackend" AS ENUM (
    'LEGACY_GMAIL',
    'PLATFORM_ENCRYPTED'
);

-- ── Table ───────────────────────────────────────────────────────────────────

CREATE TABLE "integration_connections" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectorType" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" "IntegrationConnectionStatus" NOT NULL,
    "credentialStatus" "IntegrationCredentialStatus" NOT NULL DEFAULT 'MISSING',
    "runtimeHealth" "IntegrationRuntimeHealth" NOT NULL DEFAULT 'UNKNOWN',
    "secretBackend" "IntegrationSecretBackend" NOT NULL,
    "credentialsRef" TEXT,
    "config" JSONB NOT NULL,
    "watermark" TEXT,
    "lastSuccessfulRunAt" TIMESTAMP(3),
    "lastFailedRunAt" TIMESTAMP(3),
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastStableErrorCode" TEXT,
    "schemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_connections_pkey" PRIMARY KEY ("id")
);

-- ── Unicités / index ────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "integration_connections_id_companyId_key"
  ON "integration_connections"("id", "companyId");

CREATE INDEX "integration_connections_companyId_status_idx"
  ON "integration_connections"("companyId", "status");

CREATE INDEX "integration_connections_companyId_connectorType_idx"
  ON "integration_connections"("companyId", "connectorType");

-- ── Foreign keys ────────────────────────────────────────────────────────────

ALTER TABLE "integration_connections"
  ADD CONSTRAINT "integration_connections_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
