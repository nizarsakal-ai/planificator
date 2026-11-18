-- Km estimés automatiques des tournées (ajout seul, colonnes facultatives, rétrocompatible).
ALTER TABLE "vehicle_tours"
  ADD COLUMN IF NOT EXISTS "estimatedKmSource" TEXT,
  ADD COLUMN IF NOT EXISTS "estimatedKmComputedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "estimatedKmInputHash" TEXT,
  ADD COLUMN IF NOT EXISTS "estimatedKmDetail" JSONB;

ALTER TABLE "vehicle_tours" DROP CONSTRAINT IF EXISTS "vehicle_tours_estimatedKmSource_check";
ALTER TABLE "vehicle_tours" ADD CONSTRAINT "vehicle_tours_estimatedKmSource_check"
  CHECK ("estimatedKmSource" IS NULL OR "estimatedKmSource" IN ('AUTO', 'MANUAL'));

-- Reprise : une estimation déjà saisie reste manuelle (jamais écrasée) ; une tournée à venir sans
-- estimation passe en calcul automatique. Les tournées terminées ou annulées ne sont pas touchées.
UPDATE "vehicle_tours" SET "estimatedKmSource" = 'MANUAL'
  WHERE "estimatedKmSource" IS NULL AND "estimatedKm" IS NOT NULL;
UPDATE "vehicle_tours" SET "estimatedKmSource" = 'AUTO'
  WHERE "estimatedKmSource" IS NULL AND "estimatedKm" IS NULL AND "status" IN ('PLANNED', 'IN_PROGRESS');

CREATE INDEX IF NOT EXISTS "vehicle_tours_status_estimatedKmSource_estimatedKmComputedAt_idx"
  ON "vehicle_tours" ("status", "estimatedKmSource", "estimatedKmComputedAt");
