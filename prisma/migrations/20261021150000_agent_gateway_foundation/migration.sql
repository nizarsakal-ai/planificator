-- PLAN-AGENT-GATEWAY-001 — LOT-1A — agent_gateway_foundation
-- Migration EXPAND uniquement (ES-001-§12.2) : 3 types, 5 tables agent_*, index, FK.
-- Aucune table existante modifiée. Trois instructions de dérive préexistante de origin/main
-- (processed_gmail_messages.updatedAt : suppression de la valeur par défaut ; 2 renommages d'index) ont été volontairement
-- exclues : hors périmètre, à traiter dans un ticket dédié.

-- CreateEnum
CREATE TYPE "AgentPrincipalStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "AgentAccessOutcome" AS ENUM ('OK', 'BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED', 'DISABLED', 'BUSY', 'TIMEOUT', 'ERROR');

-- CreateEnum
CREATE TYPE "AgentScope" AS ENUM ('WORKSITES_READ', 'EMPLOYEES_READ', 'ASSIGNMENTS_READ', 'ABSENCES_READ');

-- CreateTable
CREATE TABLE "agent_principals" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "scopes" "AgentScope"[],
    "status" "AgentPrincipalStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "agent_principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_access_logs" (
    "id" TEXT NOT NULL,
    "principalId" TEXT,
    "companyId" TEXT,
    "presentedTokenDigest" TEXT,
    "aggregateKey" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "tool" TEXT NOT NULL,
    "paramsDigest" TEXT,
    "outcome" "AgentAccessOutcome" NOT NULL,
    "httpStatus" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_rate_windows" (
    "principalId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "agent_rate_windows_pkey" PRIMARY KEY ("principalId","windowStart")
);

-- CreateTable
CREATE TABLE "agent_anon_rate_windows" (
    "keyDigest" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "agent_anon_rate_windows_pkey" PRIMARY KEY ("keyDigest","windowStart")
);

-- CreateTable
CREATE TABLE "agent_gateway_control" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "agent_gateway_control_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_principals_tokenHash_key" ON "agent_principals"("tokenHash");

-- CreateIndex
CREATE INDEX "agent_principals_companyId_idx" ON "agent_principals"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_principals_companyId_name_key" ON "agent_principals"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "agent_access_logs_aggregateKey_key" ON "agent_access_logs"("aggregateKey");

-- CreateIndex
CREATE INDEX "agent_access_logs_principalId_createdAt_idx" ON "agent_access_logs"("principalId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_access_logs_companyId_createdAt_idx" ON "agent_access_logs"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_access_logs_presentedTokenDigest_createdAt_idx" ON "agent_access_logs"("presentedTokenDigest", "createdAt");

-- CreateIndex
CREATE INDEX "agent_access_logs_createdAt_idx" ON "agent_access_logs"("createdAt");

-- CreateIndex
CREATE INDEX "agent_rate_windows_windowStart_idx" ON "agent_rate_windows"("windowStart");

-- CreateIndex
CREATE INDEX "agent_anon_rate_windows_windowStart_idx" ON "agent_anon_rate_windows"("windowStart");

-- AddForeignKey
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_access_logs" ADD CONSTRAINT "agent_access_logs_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "agent_principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_rate_windows" ADD CONSTRAINT "agent_rate_windows_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "agent_principals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
