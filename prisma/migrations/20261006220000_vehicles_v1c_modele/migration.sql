-- VEHICLES V1C — Identité véhicule : colonne `modele` (schéma uniquement, additif).
--
-- Contenu : trucks.modele TEXT NULL — rien d'autre.
--
-- Hors périmètre (volontairement absent) : DEFAULT, NOT NULL, UPDATE / backfill, renommage de `marque`,
-- DROP, modification de FK ou de CHECK (V1A / V1B-db), toute modification de truck_assignments.
-- Les valeurs existantes de `marque` (souvent « marque modèle ») restent strictement intactes ; `modele` reste NULL
-- pour tous les véhicules existants et se complète progressivement depuis l'application.
--
-- Compatibilité : code V1B-db (déployé) + cette DB : compatible (colonne nullable ignorée).
-- Code V1C + DB sans cette colonne : INCOMPATIBLE (Prisma sélectionne toutes les colonnes de `trucks`).
-- Ordre de déploiement obligatoire : `prisma migrate deploy` AVANT le code V1C (Vercel n'exécute pas migrate deploy).
--
-- Atomicité : une seule transaction explicite BEGIN…COMMIT (même contrat que V1A / V1B-db).
-- Verrou : ADD COLUMN nullable sans DEFAULT ne réécrit pas la table (PostgreSQL ≥ 11) ; ACCESS EXCLUSIVE bref sur
-- `trucks`, borné par lock_timeout (5 s) → échec propre et complet en cas de contention.
--
-- Runbook en cas d'échec (NE PAS exécuter sans autorisation) :
--   1. lire l'erreur ; aucune structure de ce lot ne subsiste ;
--   2. prisma migrate resolve --rolled-back 20261006220000_vehicles_v1c_modele
--   3. relancer prisma migrate deploy.
--
-- Rollback manuel après commit : ALTER TABLE "trucks" DROP COLUMN "modele" (perd les modèles saisis depuis).
--
-- `prisma db push` ne rejoue PAS ce fichier. N'utiliser que `prisma migrate deploy` pour les bases partagées.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "trucks" ADD COLUMN     "modele" TEXT;

COMMIT;
