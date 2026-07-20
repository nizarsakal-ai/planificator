-- PLAN-BOOKING-RELIABILITY-001-R1
-- Contrainte unique additive (companyId, gmailMessageId) pour idempotence Pending.
-- Déduplication préalable : conserve la plus ancienne ligne par couple.

DELETE FROM "pending_accommodations" AS a
USING "pending_accommodations" AS b
WHERE a."companyId" = b."companyId"
  AND a."gmailMessageId" = b."gmailMessageId"
  AND a."createdAt" > b."createdAt";

-- Si égalité de createdAt, garder l'id lexicographiquement plus petit
DELETE FROM "pending_accommodations" AS a
USING "pending_accommodations" AS b
WHERE a."companyId" = b."companyId"
  AND a."gmailMessageId" = b."gmailMessageId"
  AND a.id > b.id;

CREATE UNIQUE INDEX "pending_accommodations_companyId_gmailMessageId_key"
  ON "pending_accommodations"("companyId", "gmailMessageId");
