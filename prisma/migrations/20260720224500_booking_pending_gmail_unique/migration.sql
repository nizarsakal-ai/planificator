-- PLAN-BOOKING-RELIABILITY-001-R2
-- Option A : contrainte unique (companyId, gmailMessageId) UNIQUEMENT si aucun doublon.
-- Aucun DELETE. Aucune consolidation automatique.
--
-- Diagnostic manuel (si la migration échoue) :
--   SELECT "companyId", "gmailMessageId", COUNT(*) AS n,
--          array_agg(id ORDER BY "createdAt") AS ids,
--          array_agg(status::text ORDER BY "createdAt") AS statuses,
--          array_agg("accommodationId" ORDER BY "createdAt") AS accommodation_ids
--   FROM "pending_accommodations"
--   GROUP BY "companyId", "gmailMessageId"
--   HAVING COUNT(*) > 1;
--
-- Procédure : consolider manuellement (conserver la ligne métier pertinente,
-- notamment CONFIRMED / accommodationId non null), puis relancer migrate deploy.

DO $$
DECLARE
  dup_count integer;
  sample text;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT 1
    FROM "pending_accommodations"
    GROUP BY "companyId", "gmailMessageId"
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    SELECT string_agg(fmt, E'\n') INTO sample
    FROM (
      SELECT format(
        'companyId=%s gmailMessageId=%s count=%s ids=%s statuses=%s',
        "companyId",
        "gmailMessageId",
        COUNT(*),
        string_agg(id, ',' ORDER BY "createdAt", id),
        string_agg(status::text, ',' ORDER BY "createdAt", id)
      ) AS fmt
      FROM "pending_accommodations"
      GROUP BY "companyId", "gmailMessageId"
      HAVING COUNT(*) > 1
      LIMIT 20
    ) s;

    RAISE EXCEPTION
      'PLAN-BOOKING-RELIABILITY-001: % groupe(s) de doublons pending_accommodations. Aucune suppression automatique. Consolider manuellement puis relancer. Diagnostic: %',
      dup_count,
      COALESCE(sample, '(vide)');
  END IF;
END $$;

CREATE UNIQUE INDEX "pending_accommodations_companyId_gmailMessageId_key"
  ON "pending_accommodations"("companyId", "gmailMessageId");
