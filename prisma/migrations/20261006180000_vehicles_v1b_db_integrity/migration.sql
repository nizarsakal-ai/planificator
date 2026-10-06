-- VEHICLES V1B-db — Intégrité de l'historique véhicule.
--
-- Contenu :
--   - BACKFILL : truck_assignments.reason NULL → 'BACKFILL' (seule colonne écrite, aucune autre donnée métier) ;
--   - FK historiques → ON DELETE RESTRICT (ON UPDATE reste CASCADE) :
--       truck_assignments.truckId     → trucks     (CASCADE  → RESTRICT)
--       truck_assignments.chauffeurId → employees  (SET NULL → RESTRICT)
--       truck_assignments.teamId      → teams      (SET NULL → RESTRICT)
--     chauffeurId et teamId restent nullables : NULL = période sans chauffeur / sans équipe.
--     Une référence historique non NULL n'est plus jamais effacée par la suppression de son objet.
--     trucks.chauffeurId / trucks.teamId (état courant) et les FK Company (RESTRICT, V1A) sont inchangés ;
--   - CHECK truck_assignments_v1b_chronology_check : endedAt IS NULL OR endedAt >= startedAt ;
--   - CHECK truck_assignments_v1b_reason_required_check : reason IS NOT NULL (après BACKFILL).
--
-- Hors périmètre : aucune période créée/supprimée, aucune date / truckId / chauffeurId / teamId / companyId modifié,
-- aucune reclassification CREATED/REASSIGNED/DISPLACED (indémontrable pour l'existant), aucun chauffeurId NULL reconstruit.
--
-- Compatibilité : code V1B (déployé) + cette DB : l'historique est préservé ; une suppression d'employé référencé échoue
-- en FK (le code V1B-db la refuse proprement avant). Code V1B-db + DB V1A : compatible (garde applicatif seul).
-- Ordre de déploiement : code V1B-db d'abord, puis preflight, puis `prisma migrate deploy` (Vercel ne l'exécute pas).
--
-- Atomicité : une seule transaction explicite BEGIN…COMMIT. Tous les gardes s'exécutent avant tout DDL destructif ;
-- tout RAISE EXCEPTION annule l'intégralité du lot.
--
-- Runbook en cas d'échec (NE PAS exécuter sans autorisation) :
--   1. lire le diagnostic RAISE ; aucune modification de ce lot ne subsiste ;
--   2. corriger EXPLICITEMENT les données (aucune correction automatique ici) ;
--   3. prisma migrate resolve --rolled-back 20261006180000_vehicles_v1b_db_integrity
--   4. relancer prisma migrate deploy.
--
-- Rollback manuel après commit (compensation) : recréer les trois FK d'origine (truckId CASCADE, chauffeurId et teamId
-- SET NULL, ON UPDATE CASCADE) et supprimer les deux CHECK. Le BACKFILL n'est pas réversible (inoffensif).
--
-- Verrous : ACCESS EXCLUSIVE sur truck_assignments, SHARE ROW EXCLUSIVE sur employees, teams, trucks, pris d'emblée
-- dans un ordre fixe et conservés jusqu'au COMMIT : aucune suppression d'employé / d'équipe / de camion ni écriture
-- d'historique ne peut s'intercaler entre les gardes et le DDL. lock_timeout (5 s) → échec propre et complet.
--
-- `prisma db push` ne rejoue PAS ce fichier (ni CHECK, ni backfill). N'utiliser que `prisma migrate deploy`.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Verrous déterministes ─────────────────────────────────────────────────

LOCK TABLE "truck_assignments" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "employees", "teams", "trucks" IN SHARE ROW EXCLUSIVE MODE;

-- ── 1. Gardes (lecture seule) ────────────────────────────────────────────────

DO $$
DECLARE
  n integer;
  sample text;
  fk record;
  info record;
BEGIN
  -- A. Chronologie négative (incompatible avec le CHECK chronologique).
  SELECT COUNT(*) INTO n FROM "truck_assignments" WHERE "endedAt" < "startedAt";
  IF n > 0 THEN
    SELECT string_agg(format('period=%s truck=%s startedAt=%s endedAt=%s', x."id", x."truckId", x."startedAt", x."endedAt"), E'\n') INTO sample
    FROM (
      SELECT "id", "truckId", "startedAt", "endedAt" FROM "truck_assignments"
      WHERE "endedAt" < "startedAt" ORDER BY "id" LIMIT 20
    ) x;
    RAISE EXCEPTION 'VEHICLES_V1B_DB: % période(s) avec endedAt < startedAt. Aucune correction automatique.%', n, E'\n' || sample;
  END IF;

  -- B. Références orphelines (impossibles avec les FK actuelles : vérifié, jamais présumé).
  SELECT COUNT(*) INTO n FROM "truck_assignments" a LEFT JOIN "trucks" t ON t."id" = a."truckId" WHERE t."id" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'VEHICLES_V1B_DB: % période(s) sans véhicule (truckId orphelin).', n; END IF;

  SELECT COUNT(*) INTO n FROM "truck_assignments" a LEFT JOIN "employees" e ON e."id" = a."chauffeurId"
  WHERE a."chauffeurId" IS NOT NULL AND e."id" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'VEHICLES_V1B_DB: % période(s) avec chauffeurId orphelin.', n; END IF;

  SELECT COUNT(*) INTO n FROM "truck_assignments" a LEFT JOIN "teams" tm ON tm."id" = a."teamId"
  WHERE a."teamId" IS NOT NULL AND tm."id" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'VEHICLES_V1B_DB: % période(s) avec teamId orphelin.', n; END IF;

  SELECT COUNT(*) INTO n FROM "truck_assignments" a LEFT JOIN "companies" c ON c."id" = a."companyId" WHERE c."id" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'VEHICLES_V1B_DB: % période(s) avec companyId orphelin.', n; END IF;

  -- C. Valeur d'enum BACKFILL (V1A).
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t."oid" = e."enumtypid"
    WHERE t."typname" = 'TruckAssignmentReason' AND e."enumlabel" = 'BACKFILL'
  ) THEN
    RAISE EXCEPTION 'VEHICLES_V1B_DB: valeur BACKFILL absente de l''enum TruckAssignmentReason (V1A non appliquée ?).';
  END IF;

  -- D. FK à remplacer : nom, table référencée, colonne et actions exactement conformes à l'état attendu.
  FOR fk IN
    SELECT * FROM (VALUES
      ('truck_assignments_truckId_fkey',     'truckId',     'trucks',    'c'),
      ('truck_assignments_chauffeurId_fkey', 'chauffeurId', 'employees', 'n'),
      ('truck_assignments_teamId_fkey',      'teamId',      'teams',     'n')
    ) AS v("conname", "col", "reftable", "deltype")
  LOOP
    SELECT c."confdeltype" AS deltype, c."confupdtype" AS updtype, rt."relname" AS reftable,
           a."attname" AS col, ra."attname" AS refcol, array_length(c."conkey", 1) AS nkeys
      INTO info
    FROM "pg_constraint" c
    JOIN "pg_class" rt ON rt."oid" = c."confrelid"
    JOIN "pg_attribute" a ON a."attrelid" = c."conrelid" AND a."attnum" = c."conkey"[1]
    JOIN "pg_attribute" ra ON ra."attrelid" = c."confrelid" AND ra."attnum" = c."confkey"[1]
    WHERE c."conrelid" = to_regclass('"truck_assignments"') AND c."conname" = fk."conname" AND c."contype" = 'f';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'VEHICLES_V1B_DB: FK % introuvable sur truck_assignments.', fk."conname";
    END IF;
    IF info.reftable <> fk."reftable" OR info.col <> fk."col" OR info.refcol <> 'id' OR info.nkeys <> 1
       OR info.deltype <> fk."deltype" OR info.updtype <> 'c' THEN
      RAISE EXCEPTION 'VEHICLES_V1B_DB: FK % inattendue (table=%, colonne=%, ref=%, ON DELETE=%, ON UPDATE=%).',
        fk."conname", info.reftable, info.col, info.refcol, info.deltype, info.updtype;
    END IF;
  END LOOP;

  -- E. Trigger V1A attendu (période ouverte unique) et sa fonction.
  IF NOT EXISTS (
    SELECT 1 FROM "pg_trigger" tg
    WHERE tg."tgrelid" = to_regclass('"truck_assignments"')
      AND tg."tgname" = 'truck_assignments_v1a_open_for_truck_id' AND NOT tg."tgisinternal"
  ) THEN
    RAISE EXCEPTION 'VEHICLES_V1B_DB: trigger truck_assignments_v1a_open_for_truck_id absent (V1A non appliquée ?).';
  END IF;

  -- F. Aucune collision avec les nouvelles contraintes.
  IF EXISTS (
    SELECT 1 FROM "pg_constraint" c
    WHERE c."conrelid" = to_regclass('"truck_assignments"')
      AND c."conname" IN ('truck_assignments_v1b_chronology_check', 'truck_assignments_v1b_reason_required_check')
  ) THEN
    RAISE EXCEPTION 'VEHICLES_V1B_DB: une contrainte truck_assignments_v1b_* existe déjà.';
  END IF;
END $$;

-- ── 2. BACKFILL : reason NULL → BACKFILL (aucune autre colonne métier) ───────
-- Indémontrable d'inférer CREATED / REASSIGNED / DISPLACED pour l'existant : BACKFILL uniquement. Idempotent.
-- Le trigger V1A recalcule openForTruckId à l'identique (technique, sans effet).

UPDATE "truck_assignments" SET "reason" = 'BACKFILL' WHERE "reason" IS NULL;

DO $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM "truck_assignments" WHERE "reason" IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'VEHICLES_V1B_DB: % période(s) avec reason NULL après BACKFILL.', n;
  END IF;
END $$;

-- ── 3. FK historiques : RESTRICT (un seul ALTER TABLE, noms conservés après vérification en 1.D) ──

ALTER TABLE "truck_assignments"
  DROP CONSTRAINT "truck_assignments_truckId_fkey",
  DROP CONSTRAINT "truck_assignments_chauffeurId_fkey",
  DROP CONSTRAINT "truck_assignments_teamId_fkey",
  ADD CONSTRAINT "truck_assignments_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "trucks"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "truck_assignments_chauffeurId_fkey" FOREIGN KEY ("chauffeurId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "truck_assignments_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 4. CHECK (validés sur l'existant) ────────────────────────────────────────

ALTER TABLE "truck_assignments" ADD CONSTRAINT "truck_assignments_v1b_chronology_check"
  CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");

ALTER TABLE "truck_assignments" ADD CONSTRAINT "truck_assignments_v1b_reason_required_check"
  CHECK ("reason" IS NOT NULL);

-- ── 5. Assertions finales ────────────────────────────────────────────────────

DO $$
DECLARE
  n integer;
  fk record;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('truck_assignments_truckId_fkey'),
      ('truck_assignments_chauffeurId_fkey'),
      ('truck_assignments_teamId_fkey')
    ) AS v("conname")
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM "pg_constraint" c
      WHERE c."conrelid" = to_regclass('"truck_assignments"') AND c."conname" = fk."conname" AND c."contype" = 'f'
        AND c."confdeltype" = 'r' AND c."confupdtype" = 'c' AND c."convalidated"
    ) THEN
      RAISE EXCEPTION 'VEHICLES_V1B_DB: FK % non conforme après remplacement (attendu RESTRICT / CASCADE, validée).', fk."conname";
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO n FROM "pg_constraint" c
  WHERE c."conrelid" = to_regclass('"truck_assignments"') AND c."contype" = 'c' AND c."convalidated"
    AND c."conname" IN ('truck_assignments_v1b_chronology_check', 'truck_assignments_v1b_reason_required_check');
  IF n <> 2 THEN
    RAISE EXCEPTION 'VEHICLES_V1B_DB: CHECK v1b manquants ou non validés (% / 2).', n;
  END IF;

  SELECT COUNT(*) INTO n FROM "truck_assignments" WHERE "reason" IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'VEHICLES_V1B_DB: reason NULL résiduel (%).', n; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "pg_trigger" tg
    WHERE tg."tgrelid" = to_regclass('"truck_assignments"')
      AND tg."tgname" = 'truck_assignments_v1a_open_for_truck_id' AND NOT tg."tgisinternal"
  ) THEN
    RAISE EXCEPTION 'VEHICLES_V1B_DB: trigger V1A disparu.';
  END IF;
END $$;

COMMIT;
