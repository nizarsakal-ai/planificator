-- LOT-ADMIN-REVIEW — rollback de 20261031090000_worksite_photos_admin_review (NON exécuté automatiquement par Prisma).
-- Autorisé uniquement tant qu'AUCUNE photo n'a été validée, mise en rejet, rejetée ou n'a de demande de suppression attribuée : le script LE VÉRIFIE sous verrou
-- et REFUSE sinon (transaction annulée, entrée _prisma_migrations conservée). Après usage, le retrait exige l'export du
-- journal et l'arbitrage de l'Autorité Architecture.
-- Repli applicatif normal = retour au code précédent : les colonnes ajoutées sont nullables et ignorées par lui, tant
-- qu'aucune photo n'est REJECTED (valeur inconnue de l'ancien client Prisma).
-- La valeur d'énumération WorksitePhotoStatus.REJECTED n'est pas retirée (PostgreSQL ne retire pas une valeur d'enum) :
-- inoffensive sans ligne qui la porte. La fonction de garde est restaurée À L'IDENTIQUE de celle du Lot 1.
BEGIN;
LOCK TABLE "worksite_truck_photos" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "worksite_truck_photos" WHERE "status"::text = 'REJECTED') THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : des photos sont REJECTED.';
  END IF;
  IF EXISTS (SELECT 1 FROM "worksite_truck_photos" WHERE "approvedAt" IS NOT NULL OR "approvedById" IS NOT NULL OR "approvedByNameSnapshot" IS NOT NULL) THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : des photos portent une validation interne.';
  END IF;
  IF EXISTS (SELECT 1 FROM "worksite_truck_photos" WHERE "rejectRequestedAt" IS NOT NULL OR "rejectRequestedById" IS NOT NULL OR "rejectRequestedByNameSnapshot" IS NOT NULL OR "rejectedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : des photos portent une intention de rejet.';
  END IF;
  IF EXISTS (SELECT 1 FROM "worksite_truck_photos" WHERE "trashRequestedById" IS NOT NULL OR "trashRequestedByNameSnapshot" IS NOT NULL) THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : des demandes de suppression sont attribuées.';
  END IF;
END $$;
-- Fonction de garde du Lot 1, recopiée à l'identique depuis 20261030180000_worksite_photos_lot1/migration.sql.
CREATE OR REPLACE FUNCTION "worksite_photos_guard_photo"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: une photo ne se supprime pas en SQL ; cycle PENDING→SENT→DELETED.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_no_delete_check';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'WORKSITE_PHOTOS: insertion possible en PENDING uniquement.'
        USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_insert_pending_check';
    END IF;
    NEW."uploadedAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  -- UPDATE
  IF NEW."id" <> OLD."id" OR NEW."companyId" <> OLD."companyId" OR NEW."worksiteId" <> OLD."worksiteId"
     OR NEW."truckId" <> OLD."truckId" OR NEW."reservationId" <> OLD."reservationId" OR NEW."phase" <> OLD."phase"
     OR NEW."driveFileId" <> OLD."driveFileId" OR NEW."drivePath" <> OLD."drivePath" OR NEW."sha256" <> OLD."sha256"
     OR NEW."sizeBytes" <> OLD."sizeBytes" OR NEW."mimeType" <> OLD."mimeType" OR NEW."originalFilename" <> OLD."originalFilename"
     OR NEW."uploadedById" <> OLD."uploadedById" OR NEW."uploadedByNameSnapshot" <> OLD."uploadedByNameSnapshot"
     OR NEW."uploadedAt" <> OLD."uploadedAt" OR NEW."takenAt" IS DISTINCT FROM OLD."takenAt" THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: identité, fichier et auteur d''une photo sont figés.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_immutable_identity_check';
  END IF;
  IF NOT ((OLD."status" = NEW."status")
          OR (OLD."status" = 'PENDING' AND NEW."status" = 'SENT')
          OR (OLD."status" = 'SENT' AND NEW."status" = 'DELETED')) THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: transition % → % interdite.', OLD."status", NEW."status"
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_transition_check';
  END IF;
  IF OLD."status" IN ('SENT', 'DELETED') AND (
       NEW."sentAt" IS DISTINCT FROM OLD."sentAt" OR NEW."sentTo" IS DISTINCT FROM OLD."sentTo"
       OR NEW."sentMessageId" IS DISTINCT FROM OLD."sentMessageId" OR NEW."sentTransportKind" IS DISTINCT FROM OLD."sentTransportKind"
       OR NEW."sentTransportRef" IS DISTINCT FROM OLD."sentTransportRef" OR NEW."sentByAgent" IS DISTINCT FROM OLD."sentByAgent") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: la preuve d''envoi est figée après SENT.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_proof_frozen_check';
  END IF;
  IF (OLD."trashRequestedAt" IS NOT NULL AND NEW."trashRequestedAt" IS DISTINCT FROM OLD."trashRequestedAt")
     OR (OLD."trashedAt" IS NOT NULL AND NEW."trashedAt" IS DISTINCT FROM OLD."trashedAt")
     OR (OLD."purgedAt" IS NOT NULL AND NEW."purgedAt" IS DISTINCT FROM OLD."purgedAt")
     OR (OLD."unsentAlertedAt" IS NOT NULL AND NEW."unsentAlertedAt" IS DISTINCT FROM OLD."unsentAlertedAt") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: un horodatage posé ne se modifie plus.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_timestamps_monotonic_check';
  END IF;
  RETURN NEW;
END
$fn$;
ALTER TABLE "worksite_truck_photos" DROP CONSTRAINT IF EXISTS "worksite_truck_photos_reject_timeline_check";
ALTER TABLE "worksite_truck_photos" DROP CONSTRAINT IF EXISTS "worksite_truck_photos_rejected_check";
ALTER TABLE "worksite_truck_photos" DROP CONSTRAINT IF EXISTS "worksite_truck_photos_review_values_check";
DROP INDEX IF EXISTS "worksite_truck_photos_companyId_uploadedAt_id_idx";
ALTER TABLE "worksite_truck_photos" DROP COLUMN IF EXISTS "trashRequestedByNameSnapshot";
ALTER TABLE "worksite_truck_photos" DROP COLUMN IF EXISTS "trashRequestedById";
ALTER TABLE "worksite_truck_photos" DROP COLUMN IF EXISTS "rejectedAt";
ALTER TABLE "worksite_truck_photos" DROP COLUMN IF EXISTS "rejectRequestedByNameSnapshot";
ALTER TABLE "worksite_truck_photos" DROP COLUMN IF EXISTS "rejectRequestedById";
ALTER TABLE "worksite_truck_photos" DROP COLUMN IF EXISTS "rejectRequestedAt";
ALTER TABLE "worksite_truck_photos" DROP COLUMN IF EXISTS "approvedByNameSnapshot";
ALTER TABLE "worksite_truck_photos" DROP COLUMN IF EXISTS "approvedById";
ALTER TABLE "worksite_truck_photos" DROP COLUMN IF EXISTS "approvedAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261031090000_worksite_photos_admin_review';
COMMIT;
