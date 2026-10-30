-- SPEC-WORKSITE-PHOTOS-001 — Lot 1 — rollback (NON exécuté automatiquement par Prisma).
-- Autorisé uniquement tant qu'aucune donnée n'existe dans les tables worksite_photo* et qu'aucun contact client n'est renseigné :
-- le script LE VÉRIFIE sous verrou et REFUSE sinon (la transaction est annulée, l'entrée _prisma_migrations reste en place).
-- Après mise en service, le retrait de schéma exige l'export du journal d'événements et l'arbitrage de l'Autorité Architecture.
-- Repli applicatif normal = drapeau PLANIFICATOR_WORKSITE_PHOTOS_ENABLED absent (tables inertes).
-- La valeur d'énumération NotificationType.WORKSITE_PHOTO_UNSENT n'est pas retirée (PostgreSQL ne retire pas une valeur d'enum) : inoffensive.
BEGIN;
-- Verrous AVANT le contrôle de vacuité : aucune insertion concurrente ne peut se glisser entre le contrôle et les DROP.
LOCK TABLE "worksite_photo_events", "worksite_truck_photos", "worksite_photo_upload_reservations",
           "worksite_photo_drive_folders", "worksite_photo_drive_connections" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "worksites" IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "worksite_photo_events") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : worksite_photo_events contient des lignes (journal à exporter d''abord).';
  END IF;
  IF EXISTS (SELECT 1 FROM "worksite_truck_photos") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : worksite_truck_photos contient des lignes.';
  END IF;
  IF EXISTS (SELECT 1 FROM "worksite_photo_upload_reservations") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : worksite_photo_upload_reservations contient des lignes.';
  END IF;
  IF EXISTS (SELECT 1 FROM "worksite_photo_drive_folders") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : worksite_photo_drive_folders contient des lignes.';
  END IF;
  IF EXISTS (SELECT 1 FROM "worksite_photo_drive_connections") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : worksite_photo_drive_connections contient des lignes.';
  END IF;
  IF EXISTS (SELECT 1 FROM "worksites" WHERE "clientContact" IS NOT NULL) THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : des chantiers ont un clientContact renseigné (colonne non vide).';
  END IF;
END $$;
DROP TRIGGER IF EXISTS "worksite_photo_upload_reservations_publication" ON "worksite_photo_upload_reservations";
DROP TRIGGER IF EXISTS "worksite_truck_photos_publication" ON "worksite_truck_photos";
DROP TRIGGER IF EXISTS "worksite_photo_events_append_only" ON "worksite_photo_events";
DROP TRIGGER IF EXISTS "worksite_photo_upload_reservations_guard" ON "worksite_photo_upload_reservations";
DROP TRIGGER IF EXISTS "worksite_truck_photos_guard" ON "worksite_truck_photos";
DROP FUNCTION IF EXISTS "worksite_photos_check_publication"();
DROP FUNCTION IF EXISTS "worksite_photos_append_only"();
DROP FUNCTION IF EXISTS "worksite_photos_guard_reservation"();
DROP FUNCTION IF EXISTS "worksite_photos_guard_photo"();
DROP TABLE IF EXISTS "worksite_photo_events";
DROP TABLE IF EXISTS "worksite_truck_photos";
DROP TABLE IF EXISTS "worksite_photo_upload_reservations";
DROP TABLE IF EXISTS "worksite_photo_drive_folders";
DROP TABLE IF EXISTS "worksite_photo_drive_connections";
DROP TYPE IF EXISTS "WorksitePhotoDriveConnectionStatus";
DROP TYPE IF EXISTS "WorksitePhotoDriveFolderState";
DROP TYPE IF EXISTS "WorksitePhotoReservationCloseReason";
DROP TYPE IF EXISTS "WorksitePhotoReservationState";
DROP TYPE IF EXISTS "WorksitePhotoStatus";
DROP TYPE IF EXISTS "WorksitePhotoPhase";
ALTER TABLE "worksites" DROP COLUMN IF EXISTS "clientContact";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261030180000_worksite_photos_lot1';
COMMIT;
