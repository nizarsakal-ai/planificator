BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE "vehicle_cartography_admission" (
 "provider" TEXT PRIMARY KEY,
 "nextAllowedAt" TIMESTAMPTZ NOT NULL
);
CREATE TABLE "vehicle_cartography_cache" (
 "key" TEXT PRIMARY KEY,
 "companyId" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
 "value" JSONB NOT NULL,
 "expiresAt" TIMESTAMPTZ NOT NULL
);
CREATE INDEX "vehicle_cartography_cache_expiresAt_idx" ON "vehicle_cartography_cache"("expiresAt");
COMMIT;
