-- SPEC-WORKSITE-PHOTOS-001 / ADR-PLAN-005 — Lot 1 — worksite_photos_lot1
-- Migration EXPAND uniquement (ES-001-§12.2) : 6 types, 5 tables worksite_photo*, 1 colonne nullable
-- sur "worksites" (clientContact), 1 valeur d'énumération NotificationType, index, FK composites RESTRICT,
-- contraintes CHECK et déclencheurs d'intégrité (cycle de vie des photos, preuve d'envoi figée,
-- machine d'états des réservations, journal en ajout seul). Aucune donnée insérée, aucune ligne modifiée.
-- Prérequis : PostgreSQL ≥ 15 (index unique NULLS NOT DISTINCT) ; production déjà ≥ 17 (LOT-1A).

-- 0. Valeur d'énumération : hors transaction (ADD VALUE n'est pas utilisable dans la transaction qui l'ajoute).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WORKSITE_PHOTO_UNSENT';

BEGIN;

-- 1. Objets générés par `prisma migrate diff` (schéma origin/main → schéma Lot 1), relus et bornés.
-- CreateEnum
CREATE TYPE "WorksitePhotoPhase" AS ENUM ('BEFORE', 'AFTER');

-- CreateEnum
CREATE TYPE "WorksitePhotoStatus" AS ENUM ('PENDING', 'SENT', 'DELETED');

-- CreateEnum
CREATE TYPE "WorksitePhotoReservationState" AS ENUM ('RESERVED', 'UPLOADING', 'COMMITTED', 'ABANDONED', 'CLEANING', 'CLOSED');

-- CreateEnum
CREATE TYPE "WorksitePhotoReservationCloseReason" AS ENUM ('FILE_DELETED', 'OPERATOR');

-- CreateEnum
CREATE TYPE "WorksitePhotoDriveFolderState" AS ENUM ('RESERVED', 'CREATED');

-- CreateEnum
CREATE TYPE "WorksitePhotoDriveConnectionStatus" AS ENUM ('ACTIVE', 'ERROR', 'DISCONNECTED');


-- AlterTable
ALTER TABLE "worksites" ADD COLUMN     "clientContact" TEXT;

-- CreateTable
CREATE TABLE "worksite_truck_photos" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "worksiteId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "phase" "WorksitePhotoPhase" NOT NULL,
    "status" "WorksitePhotoStatus" NOT NULL DEFAULT 'PENDING',
    "driveFileId" TEXT NOT NULL,
    "drivePath" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "takenAt" TIMESTAMPTZ(3),
    "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "uploadedById" TEXT NOT NULL,
    "uploadedByNameSnapshot" TEXT NOT NULL,
    "sentAt" TIMESTAMPTZ(3),
    "sentByAgent" TEXT,
    "sentTo" TEXT,
    "sentMessageId" TEXT,
    "sentTransportKind" TEXT,
    "sentTransportRef" TEXT,
    "trashRequestedAt" TIMESTAMPTZ(3),
    "trashedAt" TIMESTAMPTZ(3),
    "purgedAt" TIMESTAMPTZ(3),
    "unsentAlertedAt" TIMESTAMPTZ(3),

    CONSTRAINT "worksite_truck_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worksite_photo_upload_reservations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "worksiteId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "photoId" TEXT NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "state" "WorksitePhotoReservationState" NOT NULL DEFAULT 'RESERVED',
    "attemptGeneration" INTEGER NOT NULL DEFAULT 1,
    "attemptOwner" UUID NOT NULL,
    "leaseExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "driveFileCreatedAt" TIMESTAMPTZ(3),
    "abandonedAt" TIMESTAMPTZ(3),
    "lastRemoteCheckAt" TIMESTAMPTZ(3),
    "remoteCheckCount" INTEGER NOT NULL DEFAULT 0,
    "unresolvedAlertedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "closeReason" "WorksitePhotoReservationCloseReason",
    "closeNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worksite_photo_upload_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worksite_photo_events" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "photoId" TEXT,
    "worksiteId" TEXT,
    "action" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorNameSnapshot" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "worksite_photo_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worksite_photo_drive_connections" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "tokenExpiry" TIMESTAMPTZ(3) NOT NULL,
    "rootFolderId" TEXT,
    "status" "WorksitePhotoDriveConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMPTZ(3),
    "connectedById" TEXT NOT NULL,
    "connectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "worksite_photo_drive_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worksite_photo_drive_folders" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "worksiteId" TEXT,
    "day" DATE,
    "driveFolderId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "state" "WorksitePhotoDriveFolderState" NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "worksite_photo_drive_folders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "worksite_truck_photos_reservationId_key" ON "worksite_truck_photos"("reservationId");

-- CreateIndex
CREATE INDEX "worksite_truck_photos_companyId_worksiteId_status_uploadedA_idx" ON "worksite_truck_photos"("companyId", "worksiteId", "status", "uploadedAt");

-- CreateIndex
CREATE INDEX "worksite_truck_photos_status_uploadedAt_idx" ON "worksite_truck_photos"("status", "uploadedAt");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_truck_photos_id_companyId_key" ON "worksite_truck_photos"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_truck_photos_reservationId_companyId_key" ON "worksite_truck_photos"("reservationId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_truck_photos_companyId_driveFileId_key" ON "worksite_truck_photos"("companyId", "driveFileId");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_photo_upload_reservations_photoId_key" ON "worksite_photo_upload_reservations"("photoId");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_photo_upload_reservations_driveFileId_key" ON "worksite_photo_upload_reservations"("driveFileId");

-- CreateIndex
CREATE INDEX "worksite_photo_upload_reservations_state_leaseExpiresAt_idx" ON "worksite_photo_upload_reservations"("state", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "worksite_photo_upload_reservations_state_lastRemoteCheckAt_idx" ON "worksite_photo_upload_reservations"("state", "lastRemoteCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_photo_upload_reservations_companyId_idempotencyKey_key" ON "worksite_photo_upload_reservations"("companyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_photo_upload_reservations_id_companyId_key" ON "worksite_photo_upload_reservations"("id", "companyId");

-- CreateIndex
CREATE INDEX "worksite_photo_events_companyId_photoId_createdAt_idx" ON "worksite_photo_events"("companyId", "photoId", "createdAt");

-- CreateIndex
CREATE INDEX "worksite_photo_events_companyId_worksiteId_createdAt_idx" ON "worksite_photo_events"("companyId", "worksiteId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_photo_drive_connections_companyId_key" ON "worksite_photo_drive_connections"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_photo_drive_folders_driveFolderId_key" ON "worksite_photo_drive_folders"("driveFolderId");

-- CreateIndex
CREATE UNIQUE INDEX "worksite_photo_drive_folders_companyId_worksiteId_day_key" ON "worksite_photo_drive_folders"("companyId", "worksiteId", "day") NULLS NOT DISTINCT;

-- AddForeignKey
ALTER TABLE "worksite_truck_photos" ADD CONSTRAINT "worksite_truck_photos_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "worksite_truck_photos" ADD CONSTRAINT "worksite_truck_photos_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "worksite_truck_photos" ADD CONSTRAINT "worksite_truck_photos_truckId_companyId_fkey" FOREIGN KEY ("truckId", "companyId") REFERENCES "trucks"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "worksite_truck_photos" ADD CONSTRAINT "worksite_truck_photos_reservationId_companyId_fkey" FOREIGN KEY ("reservationId", "companyId") REFERENCES "worksite_photo_upload_reservations"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "worksite_photo_upload_reservations" ADD CONSTRAINT "worksite_photo_upload_reservations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "worksite_photo_events" ADD CONSTRAINT "worksite_photo_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "worksite_photo_events" ADD CONSTRAINT "worksite_photo_events_photoId_companyId_fkey" FOREIGN KEY ("photoId", "companyId") REFERENCES "worksite_truck_photos"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "worksite_photo_drive_connections" ADD CONSTRAINT "worksite_photo_drive_connections_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "worksite_photo_drive_folders" ADD CONSTRAINT "worksite_photo_drive_folders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- 2. Contraintes CHECK — photos (SPEC §3.2). Preuve « complète » : sentAt, sentTo, sentMessageId,
--    sentTransportKind, sentByAgent non nuls et non vides.
ALTER TABLE "worksite_truck_photos"
  ADD CONSTRAINT "worksite_truck_photos_values_check" CHECK (
    "sizeBytes" > 0
    AND length("sha256") = 64 AND "sha256" ~ '^[0-9a-f]{64}$'
    AND "mimeType" IN ('image/jpeg', 'image/png')
    AND length(btrim("driveFileId")) > 0
    AND length(btrim("originalFilename")) > 0
    AND length(btrim("uploadedById")) > 0
    AND ("sentTo" IS NULL OR length(btrim("sentTo")) > 0)
    AND ("sentMessageId" IS NULL OR length(btrim("sentMessageId")) > 0)
    AND ("sentTransportKind" IS NULL OR "sentTransportKind" ~ '^(smtp|provider:[a-z0-9-]{1,32})$')
    AND ("sentByAgent" IS NULL OR length(btrim("sentByAgent")) > 0)
  );
ALTER TABLE "worksite_truck_photos"
  ADD CONSTRAINT "worksite_truck_photos_pending_check" CHECK (
    "status" <> 'PENDING' OR (
      "sentAt" IS NULL AND "sentTo" IS NULL AND "sentMessageId" IS NULL AND "sentTransportKind" IS NULL
      AND "sentTransportRef" IS NULL AND "sentByAgent" IS NULL
      AND "trashRequestedAt" IS NULL AND "trashedAt" IS NULL AND "purgedAt" IS NULL
    )
  );
ALTER TABLE "worksite_truck_photos"
  ADD CONSTRAINT "worksite_truck_photos_sent_check" CHECK (
    "status" <> 'SENT' OR (
      "sentAt" IS NOT NULL AND "sentTo" IS NOT NULL AND "sentMessageId" IS NOT NULL
      AND "sentTransportKind" IS NOT NULL AND "sentByAgent" IS NOT NULL
      AND "trashedAt" IS NULL AND "purgedAt" IS NULL
    )
  );
ALTER TABLE "worksite_truck_photos"
  ADD CONSTRAINT "worksite_truck_photos_deleted_check" CHECK (
    "status" <> 'DELETED' OR (
      "sentAt" IS NOT NULL AND "sentTo" IS NOT NULL AND "sentMessageId" IS NOT NULL
      AND "sentTransportKind" IS NOT NULL AND "sentByAgent" IS NOT NULL
      AND "trashRequestedAt" IS NOT NULL AND "trashedAt" IS NOT NULL
    )
  );
ALTER TABLE "worksite_truck_photos"
  ADD CONSTRAINT "worksite_truck_photos_timeline_check" CHECK (
    ("trashRequestedAt" IS NULL OR "status" IN ('SENT', 'DELETED'))
    AND ("trashedAt" IS NULL OR ("trashRequestedAt" IS NOT NULL AND "trashedAt" >= "trashRequestedAt"))
    AND ("purgedAt" IS NULL OR ("trashedAt" IS NOT NULL AND "purgedAt" >= "trashedAt"))
  );

-- 3. Contraintes CHECK — réservations et dossiers.
ALTER TABLE "worksite_photo_upload_reservations"
  ADD CONSTRAINT "worksite_photo_upload_reservations_values_check" CHECK (
    "attemptGeneration" >= 1 AND "remoteCheckCount" >= 0
    AND length("requestHash") = 64 AND "requestHash" ~ '^[0-9a-f]{64}$'
    AND length(btrim("driveFileId")) > 0 AND length(btrim("photoId")) > 0
    AND ("state" <> 'CLOSED' OR ("closedAt" IS NOT NULL AND "closeReason" IS NOT NULL))
    AND ("state" = 'CLOSED' OR ("closedAt" IS NULL AND "closeReason" IS NULL AND "closeNote" IS NULL))
    AND ("closeReason" IS DISTINCT FROM 'OPERATOR' OR length(btrim(coalesce("closeNote", ''))) > 0)
    AND ("state" NOT IN ('ABANDONED', 'CLEANING', 'CLOSED') OR "abandonedAt" IS NOT NULL)
  );
ALTER TABLE "worksite_photo_drive_folders"
  ADD CONSTRAINT "worksite_photo_drive_folders_identity_check" CHECK (
    ("day" IS NULL OR "worksiteId" IS NOT NULL)
    AND length(btrim("driveFolderId")) > 0 AND length(btrim("path")) > 0
  );

-- 4. Déclencheurs — photos : insertion en PENDING seulement ; transitions PENDING→SENT, SENT→DELETED ;
--    identité et preuve figées ; horodatages de suppression monotones (NULL → non nul) ; DELETE refusé.
CREATE FUNCTION "worksite_photos_guard_photo"() RETURNS trigger
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
CREATE TRIGGER "worksite_truck_photos_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "worksite_truck_photos" FOR EACH ROW
  EXECUTE FUNCTION "worksite_photos_guard_photo"();

-- 5. Déclencheurs — réservations : machine d'états (SPEC §3.3), identité figée, états terminaux, DELETE refusé.
CREATE FUNCTION "worksite_photos_guard_reservation"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: une réservation ne se supprime pas ; elle se clôt.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_upload_reservations_no_delete_check';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'RESERVED' THEN
      RAISE EXCEPTION 'WORKSITE_PHOTOS: une réservation naît RESERVED.'
        USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_upload_reservations_insert_check';
    END IF;
    NEW."createdAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."companyId" <> OLD."companyId" OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."requestHash" <> OLD."requestHash" OR NEW."worksiteId" <> OLD."worksiteId" OR NEW."truckId" <> OLD."truckId"
     OR NEW."uploadedById" <> OLD."uploadedById" OR NEW."photoId" <> OLD."photoId" OR NEW."driveFileId" <> OLD."driveFileId"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: l''identité d''une réservation est figée.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_upload_reservations_immutable_identity_check';
  END IF;
  IF OLD."state" IN ('COMMITTED', 'CLOSED') AND NEW."state" <> OLD."state" THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: % est un état terminal.', OLD."state"
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_upload_reservations_terminal_check';
  END IF;
  IF NEW."state" <> 'COMMITTED' AND EXISTS (SELECT 1 FROM "worksite_truck_photos" p WHERE p."reservationId" = OLD."id" AND p."companyId" = OLD."companyId") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: une réservation rattachée à une photo ne peut être qu''à l''état COMMITTED (jamais abandonnée ni nettoyée).'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_upload_reservations_attached_photo_check';
  END IF;
  IF NOT ((OLD."state" = NEW."state")
          OR (OLD."state" = 'RESERVED'  AND NEW."state" IN ('UPLOADING', 'ABANDONED'))
          OR (OLD."state" = 'UPLOADING' AND NEW."state" IN ('COMMITTED', 'ABANDONED'))
          OR (OLD."state" = 'ABANDONED' AND NEW."state" IN ('CLEANING', 'CLOSED'))
          OR (OLD."state" = 'CLEANING'  AND NEW."state" IN ('ABANDONED', 'CLOSED'))) THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: transition de réservation % → % interdite.', OLD."state", NEW."state"
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_upload_reservations_transition_check';
  END IF;
  IF OLD."state" = 'ABANDONED' AND NEW."state" = 'CLOSED' AND NEW."closeReason" <> 'OPERATOR' THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: depuis ABANDONED, seule une clôture OPERATOR est possible ; FILE_DELETED passe par CLEANING.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_upload_reservations_close_path_check';
  END IF;
  IF NEW."attemptGeneration" < OLD."attemptGeneration" THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: la génération de tentative ne décroît jamais.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_upload_reservations_generation_check';
  END IF;
  IF (OLD."driveFileCreatedAt" IS NOT NULL AND NEW."driveFileCreatedAt" IS DISTINCT FROM OLD."driveFileCreatedAt")
     OR (OLD."abandonedAt" IS NOT NULL AND NEW."abandonedAt" IS DISTINCT FROM OLD."abandonedAt")
     OR (OLD."unresolvedAlertedAt" IS NOT NULL AND NEW."unresolvedAlertedAt" IS DISTINCT FROM OLD."unresolvedAlertedAt") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: un horodatage de réservation posé ne se modifie plus.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_upload_reservations_timestamps_check';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "worksite_photo_upload_reservations_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "worksite_photo_upload_reservations" FOR EACH ROW
  EXECUTE FUNCTION "worksite_photos_guard_reservation"();

-- 5b. Contrainte différée de publication (fin de transaction) : une photo n'existe qu'avec SA réservation COMMITTED
--     (même identité, même fichier, même auteur) et une réservation ne devient COMMITTED qu'avec sa photo rattachée.
--     Différée pour laisser la transaction de publication créer la photo et passer COMMITTED dans l'ordre qu'elle veut.
CREATE FUNCTION "worksite_photos_check_publication"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  r "worksite_photo_upload_reservations"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'worksite_truck_photos' THEN
    SELECT * INTO r FROM "worksite_photo_upload_reservations"
      WHERE "id" = NEW."reservationId" AND "companyId" = NEW."companyId" FOR SHARE;
    IF NOT FOUND OR r."state" <> 'COMMITTED' OR r."photoId" <> NEW."id" OR r."driveFileId" <> NEW."driveFileId"
       OR r."worksiteId" <> NEW."worksiteId" OR r."truckId" <> NEW."truckId" OR r."uploadedById" <> NEW."uploadedById" THEN
      RAISE EXCEPTION 'WORKSITE_PHOTOS: une photo ne se rattache qu''à SA réservation COMMITTED (identité, fichier, chantier, engin, auteur).'
        USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_reservation_consistency_check';
    END IF;
  ELSIF NEW."state" = 'COMMITTED' AND NOT EXISTS (
      SELECT 1 FROM "worksite_truck_photos" p WHERE p."id" = NEW."photoId" AND p."reservationId" = NEW."id" AND p."companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: COMMITTED exige la photo rattachée dans la même transaction.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_upload_reservations_committed_photo_check';
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER "worksite_truck_photos_publication"
  AFTER INSERT ON "worksite_truck_photos" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "worksite_photos_check_publication"();
CREATE CONSTRAINT TRIGGER "worksite_photo_upload_reservations_publication"
  AFTER UPDATE OF "state" ON "worksite_photo_upload_reservations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "worksite_photos_check_publication"();

-- 6. Déclencheur — journal des événements en ajout seul.
CREATE FUNCTION "worksite_photos_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'WORKSITE_PHOTOS: % en ajout seul.', TG_TABLE_NAME
    USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_events_append_only_check';
END
$fn$;
CREATE TRIGGER "worksite_photo_events_append_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "worksite_photo_events" FOR EACH ROW
  EXECUTE FUNCTION "worksite_photos_append_only"();

-- 7. Assertions finales : aucune donnée, contraintes et déclencheurs en place.
DO $$
DECLARE
  n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM "worksite_truck_photos") OR EXISTS (SELECT 1 FROM "worksite_photo_upload_reservations")
     OR EXISTS (SELECT 1 FROM "worksite_photo_events") OR EXISTS (SELECT 1 FROM "worksite_photo_drive_connections")
     OR EXISTS (SELECT 1 FROM "worksite_photo_drive_folders") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: les tables du lot doivent être vides à la création.';
  END IF;
  SELECT count(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
    ('worksite_truck_photos_guard', 'worksite_photo_upload_reservations_guard', 'worksite_photo_events_append_only',
     'worksite_truck_photos_publication', 'worksite_photo_upload_reservations_publication');
  IF n <> 5 THEN RAISE EXCEPTION 'WORKSITE_PHOTOS: 5 déclencheurs attendus, % trouvés.', n; END IF;
  SELECT count(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgdeferrable AND tginitdeferred
    AND tgname IN ('worksite_truck_photos_publication', 'worksite_photo_upload_reservations_publication');
  IF n <> 2 THEN RAISE EXCEPTION 'WORKSITE_PHOTOS: 2 contraintes différées attendues, % trouvées.', n; END IF;
  SELECT count(*) INTO n FROM pg_constraint WHERE contype = 'c' AND conname LIKE 'worksite_%_check';
  IF n < 7 THEN RAISE EXCEPTION 'WORKSITE_PHOTOS: contraintes CHECK manquantes (% trouvées).', n; END IF;
  SELECT count(*) INTO n FROM pg_constraint WHERE contype = 'f' AND conname LIKE 'worksite_photo%_fkey' OR (contype = 'f' AND conname LIKE 'worksite_truck_photos_%_fkey');
  IF n <> 9 THEN RAISE EXCEPTION 'WORKSITE_PHOTOS: 9 clés étrangères attendues, % trouvées.', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'NotificationType' AND e.enumlabel = 'WORKSITE_PHOTO_UNSENT') THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: valeur NotificationType.WORKSITE_PHOTO_UNSENT absente.';
  END IF;
END $$;

COMMIT;
