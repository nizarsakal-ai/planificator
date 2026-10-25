-- Add an auditable non-visited outcome without fabricating a completed visit.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE "vehicle_tour_stops"
  ADD COLUMN "skippedAt" TIMESTAMPTZ(3),
  ADD COLUMN "skippedReason" TEXT,
  ADD COLUMN "skippedById" TEXT,
  ADD CONSTRAINT "vehicle_tour_stops_skippedById_fkey" FOREIGN KEY ("skippedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "vehicle_tour_stops_skip_check" CHECK (
    ("skippedAt" IS NULL AND "skippedReason" IS NULL AND "skippedById" IS NULL)
    OR ("skippedAt" IS NOT NULL AND "skippedReason" IS NOT NULL
      AND length(btrim("skippedReason")) BETWEEN 1 AND 2000
      AND "skippedById" IS NOT NULL AND "completedAt" IS NULL)
  );
COMMIT;
