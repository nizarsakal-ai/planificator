-- PLAN-BOOKING-FINAL-2 R3 — Isolation tenant + séparation identités Pending.
--
-- Atomicité : une seule transaction explicite BEGIN…COMMIT couvre tout le lot
-- (DDL, préflights, backfills, diagnostics, index). Aucun COMMIT avant BEGIN,
-- aucun COMMIT intermédiaire. Sous Prisma Migrate (PostgreSQL), ce fichier
-- s’exécute déjà dans une TX ; BEGIN/COMMIT ancre le contrat pour psql et la revue.
-- Tout RAISE EXCEPTION annule l’intégralité du lot.
--
-- Gmail : JAMAIS par défaut. Un pending n’est GMAIL que s’il existe une preuve
-- tenant-safe dans processed_gmail_messages (companyId + messageId).
--
-- Ops — lignes non classifiables (ex. ancien Agent avec gmailMessageId =
-- bookingReference, sans agent-<digits>, sans [n8n], sans ProcessedGmailMessage) :
-- corriger EXPLICITEMENT les données (reclasse / purge / rattache un messageId
-- Gmail réel) puis relancer `prisma migrate deploy`. Aucune correction automatique.
--
-- Locks (fenêtre de déploiement courte) :
--   ACCESS EXCLUSIVE bref sur ALTER / CREATE UNIQUE INDEX ;
--   RowExclusive pendant les UPDATE de backfill.
-- Relançabilité : après rollback atomique, aucune structure de ce lot n’existe.

BEGIN;

-- ── 1. Enum + colonnes (nullable d’abord) ────────────────────────────────────

CREATE TYPE "PendingAccommodationSourceKind" AS ENUM (
  'GMAIL',
  'N8N',
  'AGENT',
  'MANUAL'
);

ALTER TABLE "pending_accommodations"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "sourceKind" "PendingAccommodationSourceKind",
  ADD COLUMN "externalSourceId" TEXT;

ALTER TABLE "pending_accommodations"
  ALTER COLUMN "gmailMessageId" DROP NOT NULL;

-- ── 2. Préflights fail-closed (ambiguïtés, nulls, bornes) ────────────────────

DO $$
DECLARE
  conflict_count integer;
  conflict_sample text;
  null_gmail_count integer;
  null_gmail_sample text;
  oversize_count integer;
  oversize_sample text;
BEGIN
  -- N8N + Agent synthétique
  SELECT COUNT(*) INTO conflict_count
  FROM "pending_accommodations" p
  WHERE COALESCE(p."rawEmailSnippet", '') LIKE '[n8n]%'
    AND p."gmailMessageId" ~ '^agent-[0-9]+$';

  IF conflict_count > 0 THEN
    SELECT string_agg(id, ',' ORDER BY "createdAt", id) INTO conflict_sample
    FROM (
      SELECT id, "createdAt" FROM "pending_accommodations"
      WHERE COALESCE("rawEmailSnippet", '') LIKE '[n8n]%'
        AND "gmailMessageId" ~ '^agent-[0-9]+$'
      ORDER BY "createdAt", id LIMIT 20
    ) s;
    RAISE EXCEPTION
      'BKG-FINAL-2: % pending avec signatures concurrentes N8N+Agent. IDs: %. Résolution ops requise avant migrate deploy.',
      conflict_count, COALESCE(conflict_sample, '(vide)');
  END IF;

  -- N8N + Gmail prouvé
  SELECT COUNT(*) INTO conflict_count
  FROM "pending_accommodations" p
  WHERE COALESCE(p."rawEmailSnippet", '') LIKE '[n8n]%'
    AND p."gmailMessageId" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "processed_gmail_messages" g
      WHERE g."companyId" = p."companyId"
        AND g."messageId" = p."gmailMessageId"
    );

  IF conflict_count > 0 THEN
    SELECT string_agg(id, ',' ORDER BY "createdAt", id) INTO conflict_sample
    FROM (
      SELECT p.id, p."createdAt" FROM "pending_accommodations" p
      WHERE COALESCE(p."rawEmailSnippet", '') LIKE '[n8n]%'
        AND p."gmailMessageId" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM "processed_gmail_messages" g
          WHERE g."companyId" = p."companyId" AND g."messageId" = p."gmailMessageId"
        )
      ORDER BY p."createdAt", p.id LIMIT 20
    ) s;
    RAISE EXCEPTION
      'BKG-FINAL-2: % pending avec signatures concurrentes N8N+Gmail. IDs: %. Résolution ops requise avant migrate deploy.',
      conflict_count, COALESCE(conflict_sample, '(vide)');
  END IF;

  -- Agent synthétique + Gmail prouvé
  SELECT COUNT(*) INTO conflict_count
  FROM "pending_accommodations" p
  WHERE p."gmailMessageId" ~ '^agent-[0-9]+$'
    AND EXISTS (
      SELECT 1 FROM "processed_gmail_messages" g
      WHERE g."companyId" = p."companyId"
        AND g."messageId" = p."gmailMessageId"
    );

  IF conflict_count > 0 THEN
    SELECT string_agg(id, ',' ORDER BY "createdAt", id) INTO conflict_sample
    FROM (
      SELECT p.id, p."createdAt" FROM "pending_accommodations" p
      WHERE p."gmailMessageId" ~ '^agent-[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM "processed_gmail_messages" g
          WHERE g."companyId" = p."companyId" AND g."messageId" = p."gmailMessageId"
        )
      ORDER BY p."createdAt", p.id LIMIT 20
    ) s;
    RAISE EXCEPTION
      'BKG-FINAL-2: % pending avec signatures concurrentes Agent+Gmail. IDs: %. Résolution ops requise avant migrate deploy.',
      conflict_count, COALESCE(conflict_sample, '(vide)');
  END IF;

  -- agent-% hors format historique garanti agent-[0-9]+
  SELECT COUNT(*) INTO conflict_count
  FROM "pending_accommodations"
  WHERE "gmailMessageId" LIKE 'agent-%'
    AND "gmailMessageId" !~ '^agent-[0-9]+$';

  IF conflict_count > 0 THEN
    SELECT string_agg(id, ',' ORDER BY "createdAt", id) INTO conflict_sample
    FROM (
      SELECT id, "createdAt" FROM "pending_accommodations"
      WHERE "gmailMessageId" LIKE 'agent-%'
        AND "gmailMessageId" !~ '^agent-[0-9]+$'
      ORDER BY "createdAt", id LIMIT 20
    ) s;
    RAISE EXCEPTION
      'BKG-FINAL-2: % pending agent-%% hors format historique agent-<digits>. IDs: %. Résolution ops requise.',
      conflict_count, COALESCE(conflict_sample, '(vide)');
  END IF;

  -- gmailMessageId null avant backfill (non classifiable)
  SELECT COUNT(*) INTO null_gmail_count
  FROM "pending_accommodations"
  WHERE "gmailMessageId" IS NULL;

  IF null_gmail_count > 0 THEN
    SELECT string_agg(id, ',' ORDER BY "createdAt", id) INTO null_gmail_sample
    FROM (
      SELECT id, "createdAt" FROM "pending_accommodations"
      WHERE "gmailMessageId" IS NULL
      ORDER BY "createdAt", id LIMIT 20
    ) s;
    RAISE EXCEPTION
      'BKG-FINAL-2: % pending avec gmailMessageId NULL avant backfill. IDs: %. Consolider ops puis relancer migrate deploy.',
      null_gmail_count, COALESCE(null_gmail_sample, '(vide)');
  END IF;

  -- Bornes octets (alignées runtime IDEMPOTENCY_KEY_MAX_BYTES / GMAIL_MESSAGE_ID_MAX_BYTES)
  SELECT COUNT(*) INTO oversize_count
  FROM "pending_accommodations" p
  WHERE octet_length(p."gmailMessageId") > 256
     OR (
       COALESCE(p."rawEmailSnippet", '') LIKE '[n8n]%'
       AND octet_length('n8n:' || p."gmailMessageId") > 512
     )
     OR (
       p."gmailMessageId" ~ '^agent-[0-9]+$'
       AND octet_length('agent:' || p."gmailMessageId") > 512
     )
     OR (
       EXISTS (
         SELECT 1 FROM "processed_gmail_messages" g
         WHERE g."companyId" = p."companyId" AND g."messageId" = p."gmailMessageId"
       )
       AND octet_length('gmail:' || p."gmailMessageId") > 512
     );

  IF oversize_count > 0 THEN
    SELECT string_agg(id, ',' ORDER BY "createdAt", id) INTO oversize_sample
    FROM (
      SELECT p.id, p."createdAt" FROM "pending_accommodations" p
      WHERE octet_length(p."gmailMessageId") > 256
         OR (
           COALESCE(p."rawEmailSnippet", '') LIKE '[n8n]%'
           AND octet_length('n8n:' || p."gmailMessageId") > 512
         )
         OR (
           p."gmailMessageId" ~ '^agent-[0-9]+$'
           AND octet_length('agent:' || p."gmailMessageId") > 512
         )
         OR (
           EXISTS (
             SELECT 1 FROM "processed_gmail_messages" g
             WHERE g."companyId" = p."companyId" AND g."messageId" = p."gmailMessageId"
           )
           AND octet_length('gmail:' || p."gmailMessageId") > 512
         )
      ORDER BY p."createdAt", p.id LIMIT 20
    ) s;
    RAISE EXCEPTION
      'BKG-FINAL-2: % pending dépassent les bornes octets (gmailMessageId≤256, idempotencyKey≤512). IDs: %.',
      oversize_count, COALESCE(oversize_sample, '(vide)');
  END IF;
END $$;

-- ── 3. Backfill — preuves exclusives uniquement ──────────────────────────────

-- A. N8N prouvé
UPDATE "pending_accommodations" p
SET
  "sourceKind" = 'N8N',
  "externalSourceId" = p."gmailMessageId",
  "idempotencyKey" = 'n8n:' || p."gmailMessageId",
  "gmailMessageId" = NULL
WHERE COALESCE(p."rawEmailSnippet", '') LIKE '[n8n]%'
  AND p."gmailMessageId" IS NOT NULL
  AND p."gmailMessageId" !~ '^agent-[0-9]+$'
  AND NOT EXISTS (
    SELECT 1 FROM "processed_gmail_messages" g
    WHERE g."companyId" = p."companyId" AND g."messageId" = p."gmailMessageId"
  )
  AND p."sourceKind" IS NULL;

-- B. Agent historique synthétique prouvé (agent-<digits>)
UPDATE "pending_accommodations" p
SET
  "sourceKind" = 'AGENT',
  "externalSourceId" = NULL,
  "idempotencyKey" = 'agent:' || p."gmailMessageId",
  "gmailMessageId" = NULL
WHERE p."gmailMessageId" ~ '^agent-[0-9]+$'
  AND COALESCE(p."rawEmailSnippet", '') NOT LIKE '[n8n]%'
  AND NOT EXISTS (
    SELECT 1 FROM "processed_gmail_messages" g
    WHERE g."companyId" = p."companyId" AND g."messageId" = p."gmailMessageId"
  )
  AND p."sourceKind" IS NULL;

-- C. Gmail prouvé UNIQUEMENT via ProcessedGmailMessage (jamais par défaut)
UPDATE "pending_accommodations" p
SET
  "sourceKind" = 'GMAIL',
  "idempotencyKey" = 'gmail:' || p."gmailMessageId",
  "externalSourceId" = NULL
WHERE p."sourceKind" IS NULL
  AND p."gmailMessageId" IS NOT NULL
  AND COALESCE(p."rawEmailSnippet", '') NOT LIKE '[n8n]%'
  AND p."gmailMessageId" !~ '^agent-[0-9]+$'
  AND EXISTS (
    SELECT 1 FROM "processed_gmail_messages" g
    WHERE g."companyId" = p."companyId" AND g."messageId" = p."gmailMessageId"
  );

-- ── 4. Diagnostics post-backfill ────────────────────────────────────────────

DO $$
DECLARE
  unclassified_count integer;
  unclassified_sample text;
  dup_idempo integer;
  dup_gmail integer;
  dup_acc_ref integer;
  sample text;
BEGIN
  -- D. Tout le reste → ABORT (inclut Agent historique gmailMessageId=bookingReference)
  SELECT COUNT(*) INTO unclassified_count
  FROM "pending_accommodations"
  WHERE "idempotencyKey" IS NULL OR "sourceKind" IS NULL;

  IF unclassified_count > 0 THEN
    SELECT string_agg(id, ',' ORDER BY "createdAt", id) INTO unclassified_sample
    FROM (
      SELECT id, "createdAt" FROM "pending_accommodations"
      WHERE "idempotencyKey" IS NULL OR "sourceKind" IS NULL
      ORDER BY "createdAt", id LIMIT 20
    ) s;
    RAISE EXCEPTION
      'BKG-FINAL-2: % pending non classifiables (aucune preuve N8N/Agent/Gmail). Ex. ancien Agent avec gmailMessageId=bookingReference sans ProcessedGmailMessage. Aucune classification Gmail par défaut. IDs: %. Corriger explicitement puis relancer migrate deploy.',
      unclassified_count, COALESCE(unclassified_sample, '(vide)');
  END IF;

  SELECT COUNT(*) INTO dup_idempo
  FROM (
    SELECT 1 FROM "pending_accommodations"
    GROUP BY "companyId", "idempotencyKey" HAVING COUNT(*) > 1
  ) d;

  IF dup_idempo > 0 THEN
    SELECT string_agg(fmt, E'\n') INTO sample
    FROM (
      SELECT format(
        'companyId=%s idempotencyKey=%s count=%s ids=%s',
        "companyId", "idempotencyKey", COUNT(*),
        string_agg(id, ',' ORDER BY "createdAt", id)
      ) AS fmt
      FROM "pending_accommodations"
      GROUP BY "companyId", "idempotencyKey"
      HAVING COUNT(*) > 1
      LIMIT 20
    ) s;
    RAISE EXCEPTION
      'BKG-FINAL-2: % groupe(s) doublons (companyId, idempotencyKey). Diagnostic: %',
      dup_idempo, COALESCE(sample, '(vide)');
  END IF;

  SELECT COUNT(*) INTO dup_gmail
  FROM (
    SELECT 1 FROM "pending_accommodations"
    WHERE "gmailMessageId" IS NOT NULL
    GROUP BY "companyId", "gmailMessageId" HAVING COUNT(*) > 1
  ) d;

  IF dup_gmail > 0 THEN
    SELECT string_agg(fmt, E'\n') INTO sample
    FROM (
      SELECT format(
        'companyId=%s gmailMessageId=%s count=%s ids=%s',
        "companyId", "gmailMessageId", COUNT(*),
        string_agg(id, ',' ORDER BY "createdAt", id)
      ) AS fmt
      FROM "pending_accommodations"
      WHERE "gmailMessageId" IS NOT NULL
      GROUP BY "companyId", "gmailMessageId"
      HAVING COUNT(*) > 1
      LIMIT 20
    ) s;
    RAISE EXCEPTION
      'BKG-FINAL-2: % groupe(s) doublons (companyId, gmailMessageId). Diagnostic: %',
      dup_gmail, COALESCE(sample, '(vide)');
  END IF;

  SELECT COUNT(*) INTO dup_acc_ref
  FROM (
    SELECT 1 FROM "accommodations"
    WHERE "bookingReference" IS NOT NULL
    GROUP BY "companyId", "bookingReference" HAVING COUNT(*) > 1
  ) d;

  IF dup_acc_ref > 0 THEN
    SELECT string_agg(fmt, E'\n') INTO sample
    FROM (
      SELECT format(
        'companyId=%s bookingReference=%s count=%s ids=%s',
        "companyId", "bookingReference", COUNT(*),
        string_agg(id, ',' ORDER BY "createdAt", id)
      ) AS fmt
      FROM "accommodations"
      WHERE "bookingReference" IS NOT NULL
      GROUP BY "companyId", "bookingReference"
      HAVING COUNT(*) > 1
      LIMIT 20
    ) s;
    RAISE EXCEPTION
      'BKG-FINAL-2: % groupe(s) doublons accommodations (companyId, bookingReference). Diagnostic: %',
      dup_acc_ref, COALESCE(sample, '(vide)');
  END IF;
END $$;

-- ── 5. Contraintes ──────────────────────────────────────────────────────────

ALTER TABLE "pending_accommodations"
  ALTER COLUMN "idempotencyKey" SET NOT NULL,
  ALTER COLUMN "sourceKind" SET NOT NULL;

CREATE UNIQUE INDEX "pending_accommodations_companyId_idempotencyKey_key"
  ON "pending_accommodations"("companyId", "idempotencyKey");

CREATE INDEX "pending_accommodations_companyId_sourceKind_externalSourceId_idx"
  ON "pending_accommodations"("companyId", "sourceKind", "externalSourceId");

-- ── 6. Accommodation : unique global → composite tenant-safe ────────────────

DROP INDEX IF EXISTS "accommodations_bookingReference_key";

CREATE UNIQUE INDEX "accommodations_companyId_bookingReference_key"
  ON "accommodations"("companyId", "bookingReference");

COMMIT;
