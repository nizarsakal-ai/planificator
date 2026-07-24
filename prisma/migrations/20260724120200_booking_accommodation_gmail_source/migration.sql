-- C-BOOK-001 — Clé technique Gmail tenant-safe, séparée de bookingReference.
-- Multiple NULL autorisés par PostgreSQL sur l'index unique (NULL ≠ NULL).
-- Aucun DELETE. Aucune fusion automatique.
--
-- Diagnostic manuel (si la migration échoue) :
--   SELECT "companyId", "gmailSourceMessageId", COUNT(*) AS n,
--          array_agg(id ORDER BY "createdAt") AS ids
--   FROM "accommodations"
--   WHERE "gmailSourceMessageId" IS NOT NULL
--   GROUP BY "companyId", "gmailSourceMessageId"
--   HAVING COUNT(*) > 1;

ALTER TABLE "accommodations" ADD COLUMN "gmailSourceMessageId" TEXT;

DO $$
DECLARE
  dup_count integer;
  sample text;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT 1
    FROM "accommodations"
    WHERE "gmailSourceMessageId" IS NOT NULL
    GROUP BY "companyId", "gmailSourceMessageId"
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    SELECT string_agg(fmt, E'\n') INTO sample
    FROM (
      SELECT format(
        'companyId=%s gmailSourceMessageId=%s count=%s ids=%s',
        "companyId",
        "gmailSourceMessageId",
        COUNT(*),
        string_agg(id, ',' ORDER BY "createdAt", id)
      ) AS fmt
      FROM "accommodations"
      WHERE "gmailSourceMessageId" IS NOT NULL
      GROUP BY "companyId", "gmailSourceMessageId"
      HAVING COUNT(*) > 1
      LIMIT 20
    ) s;

    RAISE EXCEPTION
      'C-BOOK-001: % groupe(s) de doublons accommodations(gmailSourceMessageId). Aucune suppression automatique. Consolider manuellement puis relancer. Diagnostic: %',
      dup_count,
      COALESCE(sample, '(vide)');
  END IF;
END $$;

CREATE UNIQUE INDEX "accommodations_companyId_gmailSourceMessageId_key"
  ON "accommodations"("companyId", "gmailSourceMessageId");
