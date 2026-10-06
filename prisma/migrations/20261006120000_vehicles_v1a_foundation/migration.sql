-- VEHICLES V1A — Socle véhicule (schéma uniquement, additif).
--
-- Contenu :
--   - trucks : active (DEFAULT true), archivedAt (NULL) + CHECK « archivé ⇒ sans équipe ni chauffeur » ;
--   - FK companyId → companies sur trucks et truck_assignments, ON DELETE RESTRICT
--     (supprimer une entreprise n'efface jamais silencieusement véhicules ni historique) ;
--   - enum TruckAssignmentReason + truck_assignments.reason (NULL pour l'existant, aucun backfill) ;
--   - truck_assignments.openForTruckId (UNIQUE) maintenu par trigger : au plus une période ouverte par véhicule.
--
-- Hors périmètre (volontairement absent) : brand/model, @@unique([id, companyId]), BACKFILL de périodes,
-- backfill de reason, CHECK chronologique endedAt >= startedAt (V1B-db), changement d'API/UI.
-- Aucune ligne n'est supprimée ; aucune donnée métier n'est modifiée (marque, teamId, chauffeurId, dates intactes).
-- Seule écriture de lignes : initialisation de la colonne technique openForTruckId des périodes ouvertes.
--
-- Compatibilité code V0 (déployé) : V0 ne lit/écrit aucune nouvelle colonne ; active prend DEFAULT true ;
-- le trigger renseigne openForTruckId à chaque INSERT/UPDATE (V0 clôt la période courante avant d'en ouvrir une).
-- Ordre de déploiement obligatoire : migrate deploy AVANT le code généré avec ce schéma (Prisma nomme les colonnes).
--
-- Atomicité : une seule transaction explicite BEGIN…COMMIT (même contrat que 20260802120000).
-- Tous les gardes s'exécutent avant toute modification ; tout RAISE EXCEPTION annule l'intégralité du lot.
--
-- Runbook en cas d'échec (NE PAS exécuter sans autorisation) :
--   1. lire le diagnostic RAISE ; aucune structure de ce lot ne subsiste ;
--   2. corriger EXPLICITEMENT les données (aucune correction automatique ici) ;
--   3. prisma migrate resolve --rolled-back 20261006120000_vehicles_v1a_foundation
--   4. relancer prisma migrate deploy.
--
-- Verrous : dans la transaction unique, ils sont conservés jusqu'au COMMIT — ACCESS EXCLUSIVE sur trucks et
-- truck_assignments (ADD COLUMN, CHECK, trigger), SHARE ROW EXCLUSIVE sur companies (ADD FOREIGN KEY).
-- Les gardes prennent d'abord ACCESS SHARE puis les instructions suivantes montent en verrou exclusif :
-- en cas de contention, lock_timeout (5 s) provoque un échec propre et complet (relance après résolution).
-- Tables de petite taille : transaction de courte durée attendue.
--
-- `prisma db push` ne rejoue PAS ce fichier : un environnement créé par db push aurait la colonne et l'index
-- unique, mais ni le trigger ni le CHECK. N'utiliser que `prisma migrate deploy` pour les bases partagées.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Gardes (lecture seule) ────────────────────────────────────────────────

DO $$
DECLARE
  n integer;
  sample text;
BEGIN
  -- A. Véhicules dont l'entreprise n'existe pas.
  SELECT COUNT(*) INTO n
  FROM "trucks" t
  LEFT JOIN "companies" c ON c."id" = t."companyId"
  WHERE c."id" IS NULL;
  IF n > 0 THEN
    SELECT string_agg(format('truck=%s companyId=%s', x."id", x."companyId"), E'\n') INTO sample
    FROM (
      SELECT t."id", t."companyId"
      FROM "trucks" t
      LEFT JOIN "companies" c ON c."id" = t."companyId"
      WHERE c."id" IS NULL
      ORDER BY t."id"
      LIMIT 20
    ) x;
    RAISE EXCEPTION 'VEHICLES_V1A: % truck(s) orphelin(s) (companyId sans entreprise). Aucune correction automatique.%', n, E'\n' || sample;
  END IF;

  -- B. Périodes dont l'entreprise n'existe pas.
  SELECT COUNT(*) INTO n
  FROM "truck_assignments" a
  LEFT JOIN "companies" c ON c."id" = a."companyId"
  WHERE c."id" IS NULL;
  IF n > 0 THEN
    SELECT string_agg(format('period=%s truck=%s companyId=%s', x."id", x."truckId", x."companyId"), E'\n') INTO sample
    FROM (
      SELECT a."id", a."truckId", a."companyId"
      FROM "truck_assignments" a
      LEFT JOIN "companies" c ON c."id" = a."companyId"
      WHERE c."id" IS NULL
      ORDER BY a."id"
      LIMIT 20
    ) x;
    RAISE EXCEPTION 'VEHICLES_V1A: % truck_assignment(s) orphelin(s) (companyId sans entreprise). Aucune correction automatique.%', n, E'\n' || sample;
  END IF;

  -- C. Plusieurs périodes ouvertes pour un même véhicule (incompatible avec l'unicité openForTruckId).
  SELECT COUNT(*) INTO n
  FROM (
    SELECT "truckId"
    FROM "truck_assignments"
    WHERE "endedAt" IS NULL
    GROUP BY "truckId"
    HAVING COUNT(*) > 1
  ) d;
  IF n > 0 THEN
    SELECT string_agg(format('truck=%s open_periods=%s ids=%s', x."truckId", x.cnt, x.ids), E'\n') INTO sample
    FROM (
      SELECT "truckId", COUNT(*) AS cnt, string_agg("id", ',' ORDER BY "startedAt", "id") AS ids
      FROM "truck_assignments"
      WHERE "endedAt" IS NULL
      GROUP BY "truckId"
      HAVING COUNT(*) > 1
      ORDER BY "truckId"
      LIMIT 20
    ) x;
    RAISE EXCEPTION 'VEHICLES_V1A: % véhicule(s) avec plusieurs périodes ouvertes. Aucune correction automatique.%', n, E'\n' || sample;
  END IF;
END $$;

-- ── 1. Enum + colonnes (DDL identique à `prisma migrate diff`) ───────────────

-- CreateEnum
CREATE TYPE "TruckAssignmentReason" AS ENUM ('CREATED', 'REASSIGNED', 'DISPLACED', 'ARCHIVED', 'RESTORED', 'BACKFILL');

-- AlterTable
ALTER TABLE "trucks" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "truck_assignments" ADD COLUMN     "openForTruckId" TEXT,
ADD COLUMN     "reason" "TruckAssignmentReason";

-- ── 2. Archivage : un véhicule archivé n'a ni équipe ni chauffeur ────────────
-- Toutes les lignes existantes ont active = true : contrainte satisfaite sans modification.

ALTER TABLE "trucks" ADD CONSTRAINT "trucks_v1a_archived_unassigned_check"
  CHECK ("active" OR ("teamId" IS NULL AND "chauffeurId" IS NULL));

-- ── 3. Période ouverte unique : colonne sentinelle maintenue par trigger ─────
-- Fonction et trigger nommés « v1a » pour éviter toute collision ; CREATE (sans OR REPLACE) échoue
-- explicitement si un objet de même nom existe déjà.

CREATE FUNCTION "truck_assignments_v1a_sync_open_for_truck_id"() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW."openForTruckId" := CASE WHEN NEW."endedAt" IS NULL THEN NEW."truckId" ELSE NULL END;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER "truck_assignments_v1a_open_for_truck_id"
  BEFORE INSERT OR UPDATE ON "truck_assignments"
  FOR EACH ROW
  EXECUTE FUNCTION "truck_assignments_v1a_sync_open_for_truck_id"();

-- Initialisation de la sentinelle des périodes ouvertes existantes (garde C : au plus une par véhicule).
-- Seule la colonne technique est écrite ; truckId, teamId, chauffeurId, companyId, startedAt, endedAt intacts.
UPDATE "truck_assignments" SET "openForTruckId" = "truckId" WHERE "endedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "truck_assignments_openForTruckId_key" ON "truck_assignments"("openForTruckId");

-- ── 4. FK companyId → companies (RESTRICT, gardes A et B) ────────────────────

-- AddForeignKey
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_assignments" ADD CONSTRAINT "truck_assignments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
