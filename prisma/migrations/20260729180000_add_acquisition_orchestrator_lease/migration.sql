-- PLAN-ACQ-V2-001 LOT V2-1.1 — Lease durable orchestrateur Acquisition
-- Verrou nommé multi-instance (compatible Prisma / PostgreSQL / Neon / Vercel).
-- Aucune donnée seed. Aucun advisory lock.

CREATE TABLE "acquisition_orchestrator_leases" (
    "key" TEXT NOT NULL,
    "ownerRunId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "acquiredAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_orchestrator_leases_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "acquisition_orchestrator_leases_leaseExpiresAt_idx"
  ON "acquisition_orchestrator_leases"("leaseExpiresAt");
