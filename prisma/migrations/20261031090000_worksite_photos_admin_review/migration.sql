-- SPEC-WORKSITE-PHOTOS-001 / LOT-ADMIN-REVIEW — worksite_photos_admin_review
-- Migration EXPAND : contrôle Super Admin des photos (validation interne, rejet avant envoi vers la corbeille Drive).
-- Ajouts seulement : 1 valeur d'énumération (REJECTED), 9 colonnes NULLABLES sur "worksite_truck_photos", 1 index,
-- 3 contraintes CHECK, et le remplacement de la fonction de garde des photos par un SUR-ENSEMBLE STRICT de celle du
-- Lot 1 (toutes ses règles et tous ses noms de contrainte sont conservés à l'identique). Aucune ligne n'est écrite :
-- les photos existantes gardent leurs valeurs, les nouvelles colonnes valent NULL (photo « à valider »).
-- La migration 20261030180000_worksite_photos_lot1, déjà appliquée, n'est pas modifiée.
--
-- Invariants ajoutés (décisions D19 à D21, docs/specs/worksite-photos/LOT-ADMIN-REVIEW.md) :
--   * la validation interne ne change pas le statut : PENDING reste « non envoyée », SENT exige toujours la preuve de transport ;
--   * REJECTED est terminal, distinct de DELETED, sans aucun champ de preuve d'envoi ;
--   * le rejet suit deux phases : intention posée dans une instruction antérieure, puis finalisation ;
--   * une intention de rejet interdit la validation et l'envoi ;
--   * validation et intention sont attribuées, horodatées par la base (clock_timestamp) et figées ;
--   * une photo DÉJÀ ENVOYÉE se supprime par le cycle existant SENT → DELETED (trashRequestedAt / trashedAt, preuve
--     d'envoi immuable) ; sa demande devient attribuable (trashRequestedById / trashRequestedByNameSnapshot, posés en même
--     temps que trashRequestedAt, puis figés). Une photo envoyée n'est jamais requalifiée REJECTED.
--
-- Traitement des photos existantes (legacy) : aucune n'est réécrite. Une photo PENDING existante reste « à valider ».
-- Une photo SENT ou DELETED existante garde une validation NULL, affichée « non tracée (antérieure au contrôle) » :
-- aucune approbation historique n'est inventée, et la garde refuse toute validation posée après envoi
-- (worksite_truck_photos_approval_state_check). Les deux dimensions restent distinctes : validation interne
-- (approvedAt…) d'un côté, envoi au client (status SENT + preuve de transport figée) de l'autre.

-- 0. Valeur d'énumération : hors transaction (ADD VALUE n'est pas utilisable dans la transaction qui l'ajoute).
--    Les contraintes ci-dessous comparent "status"::text, sans utiliser la nouvelle valeur comme littéral d'énumération.
ALTER TYPE "WorksitePhotoStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

BEGIN;

-- 1. Colonnes nullables : aucune réécriture des lignes existantes.
ALTER TABLE "worksite_truck_photos" ADD COLUMN "approvedAt" TIMESTAMPTZ(3);
ALTER TABLE "worksite_truck_photos" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "worksite_truck_photos" ADD COLUMN "approvedByNameSnapshot" TEXT;
ALTER TABLE "worksite_truck_photos" ADD COLUMN "rejectRequestedAt" TIMESTAMPTZ(3);
ALTER TABLE "worksite_truck_photos" ADD COLUMN "rejectRequestedById" TEXT;
ALTER TABLE "worksite_truck_photos" ADD COLUMN "rejectRequestedByNameSnapshot" TEXT;
ALTER TABLE "worksite_truck_photos" ADD COLUMN "rejectedAt" TIMESTAMPTZ(3);
ALTER TABLE "worksite_truck_photos" ADD COLUMN "trashRequestedById" TEXT;
ALTER TABLE "worksite_truck_photos" ADD COLUMN "trashRequestedByNameSnapshot" TEXT;

-- 2. Index de la galerie de contrôle (toute l'entreprise, plus récentes d'abord, curseur stable).
CREATE INDEX "worksite_truck_photos_companyId_uploadedAt_id_idx" ON "worksite_truck_photos"("companyId", "uploadedAt", "id");

-- 3. Contraintes CHECK.
ALTER TABLE "worksite_truck_photos"
  ADD CONSTRAINT "worksite_truck_photos_review_values_check" CHECK (
    (("approvedAt" IS NULL AND "approvedById" IS NULL AND "approvedByNameSnapshot" IS NULL)
      OR ("approvedAt" IS NOT NULL AND length(btrim(coalesce("approvedById", ''))) > 0
          AND length(btrim(coalesce("approvedByNameSnapshot", ''))) > 0))
    AND (("rejectRequestedAt" IS NULL AND "rejectRequestedById" IS NULL AND "rejectRequestedByNameSnapshot" IS NULL)
      OR ("rejectRequestedAt" IS NOT NULL AND length(btrim(coalesce("rejectRequestedById", ''))) > 0
          AND length(btrim(coalesce("rejectRequestedByNameSnapshot", ''))) > 0))
    AND (("trashRequestedById" IS NULL AND "trashRequestedByNameSnapshot" IS NULL)
      OR ("trashRequestedAt" IS NOT NULL AND length(btrim(coalesce("trashRequestedById", ''))) > 0
          AND length(btrim(coalesce("trashRequestedByNameSnapshot", ''))) > 0))
  );
ALTER TABLE "worksite_truck_photos"
  ADD CONSTRAINT "worksite_truck_photos_rejected_check" CHECK (
    "status"::text <> 'REJECTED' OR (
      "rejectRequestedAt" IS NOT NULL AND "rejectedAt" IS NOT NULL
      AND "sentAt" IS NULL AND "sentTo" IS NULL AND "sentMessageId" IS NULL AND "sentTransportKind" IS NULL
      AND "sentTransportRef" IS NULL AND "sentByAgent" IS NULL
      AND "trashRequestedAt" IS NULL AND "trashedAt" IS NULL AND "purgedAt" IS NULL
      AND "trashRequestedById" IS NULL AND "trashRequestedByNameSnapshot" IS NULL
    )
  );
ALTER TABLE "worksite_truck_photos"
  ADD CONSTRAINT "worksite_truck_photos_reject_timeline_check" CHECK (
    ("rejectRequestedAt" IS NULL OR "status"::text IN ('PENDING', 'REJECTED'))
    AND ("rejectedAt" IS NULL OR ("status"::text = 'REJECTED' AND "rejectRequestedAt" IS NOT NULL AND "rejectedAt" >= "rejectRequestedAt"))
  );

-- 4. Fonction de garde des photos : règles du Lot 1 inchangées (mêmes messages, mêmes noms de contrainte), puis ajouts.
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
    -- Ajout : une photo naît sans validation ni rejet (ni l'une ni l'autre ne s'insère directement).
    IF NEW."approvedAt" IS NOT NULL OR NEW."approvedById" IS NOT NULL OR NEW."approvedByNameSnapshot" IS NOT NULL
       OR NEW."rejectRequestedAt" IS NOT NULL OR NEW."rejectRequestedById" IS NOT NULL
       OR NEW."rejectRequestedByNameSnapshot" IS NOT NULL OR NEW."rejectedAt" IS NOT NULL
       OR NEW."trashRequestedById" IS NOT NULL OR NEW."trashRequestedByNameSnapshot" IS NOT NULL THEN
      RAISE EXCEPTION 'WORKSITE_PHOTOS: une photo naît sans validation ni rejet.'
        USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_insert_review_check';
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
  -- Ajout : PENDING → REJECTED (rejet avant envoi). REJECTED est terminal (aucune transition ne le quitte).
  IF NOT ((OLD."status" = NEW."status")
          OR (OLD."status" = 'PENDING' AND NEW."status" = 'SENT')
          OR (OLD."status" = 'SENT' AND NEW."status" = 'DELETED')
          OR (OLD."status" = 'PENDING' AND NEW."status" = 'REJECTED')) THEN
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
  -- Ajout — rejet en deux phases : la finalisation exige une intention déjà posée par une instruction antérieure.
  IF OLD."status" = 'PENDING' AND NEW."status" = 'REJECTED' AND OLD."rejectRequestedAt" IS NULL THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: un rejet se finalise après son intention (deux phases).'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_reject_two_phase_check';
  END IF;
  -- Ajout — une intention de rejet interdit l'envoi : aucune preuve SENT ne peut viser une photo en cours de rejet.
  IF OLD."status" = 'PENDING' AND NEW."status" = 'SENT' AND (OLD."rejectRequestedAt" IS NOT NULL OR NEW."rejectRequestedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: une photo en cours de rejet ne peut pas être marquée envoyée.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_reject_blocks_send_check';
  END IF;
  -- Ajout — validation interne : seulement en PENDING sans intention de rejet ; horodatée par la base ; figée ensuite.
  IF OLD."approvedAt" IS NULL AND NEW."approvedAt" IS NOT NULL THEN
    IF OLD."status" <> 'PENDING' OR NEW."status" <> 'PENDING' OR OLD."rejectRequestedAt" IS NOT NULL OR NEW."rejectRequestedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'WORKSITE_PHOTOS: validation possible seulement sur une photo non envoyée et non rejetée.'
        USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_approval_state_check';
    END IF;
    NEW."approvedAt" := clock_timestamp();
  END IF;
  IF OLD."approvedAt" IS NOT NULL AND (NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
       OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById" OR NEW."approvedByNameSnapshot" IS DISTINCT FROM OLD."approvedByNameSnapshot") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: une validation posée est figée.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_approval_frozen_check';
  END IF;
  -- Ajout — intention de rejet : posée une fois, depuis PENDING seulement ; horodatée par la base ; figée ensuite.
  IF OLD."rejectRequestedAt" IS NULL AND NEW."rejectRequestedAt" IS NOT NULL THEN
    IF OLD."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'WORKSITE_PHOTOS: rejet possible seulement avant envoi.'
        USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_reject_state_check';
    END IF;
    NEW."rejectRequestedAt" := clock_timestamp();
  END IF;
  IF OLD."rejectRequestedAt" IS NOT NULL AND (NEW."rejectRequestedAt" IS DISTINCT FROM OLD."rejectRequestedAt"
       OR NEW."rejectRequestedById" IS DISTINCT FROM OLD."rejectRequestedById"
       OR NEW."rejectRequestedByNameSnapshot" IS DISTINCT FROM OLD."rejectRequestedByNameSnapshot") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: une intention de rejet posée est figée.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_reject_frozen_check';
  END IF;
  IF OLD."rejectedAt" IS NULL AND NEW."rejectedAt" IS NOT NULL THEN
    NEW."rejectedAt" := clock_timestamp();
  END IF;
  IF OLD."rejectedAt" IS NOT NULL AND NEW."rejectedAt" IS DISTINCT FROM OLD."rejectedAt" THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: un horodatage posé ne se modifie plus.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_timestamps_monotonic_check';
  END IF;
  -- Ajout — attribution d'une demande de suppression après envoi : posée dans la même instruction que trashRequestedAt
  -- (jamais ajoutée après coup à une demande existante), puis figée.
  IF OLD."trashRequestedById" IS NULL AND NEW."trashRequestedById" IS NOT NULL AND OLD."trashRequestedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: l''auteur d''une demande de suppression se pose avec la demande.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_trash_attribution_check';
  END IF;
  IF OLD."trashRequestedById" IS NOT NULL AND (NEW."trashRequestedById" IS DISTINCT FROM OLD."trashRequestedById"
       OR NEW."trashRequestedByNameSnapshot" IS DISTINCT FROM OLD."trashRequestedByNameSnapshot") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: l''auteur d''une demande de suppression est figé.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_truck_photos_trash_attribution_check';
  END IF;
  RETURN NEW;
END
$fn$;

-- 5. Assertions finales : colonnes, contraintes, déclencheur et valeur d'énumération en place ; aucune donnée modifiée.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'worksite_truck_photos'
    AND column_name IN ('approvedAt', 'approvedById', 'approvedByNameSnapshot', 'rejectRequestedAt', 'rejectRequestedById',
                        'rejectRequestedByNameSnapshot', 'rejectedAt', 'trashRequestedById', 'trashRequestedByNameSnapshot')
    AND is_nullable = 'YES';
  IF n <> 9 THEN RAISE EXCEPTION 'WORKSITE_PHOTOS: 9 colonnes nullables attendues, % trouvées.', n; END IF;
  SELECT count(*) INTO n FROM pg_constraint WHERE contype = 'c' AND conname IN
    ('worksite_truck_photos_review_values_check', 'worksite_truck_photos_rejected_check', 'worksite_truck_photos_reject_timeline_check');
  IF n <> 3 THEN RAISE EXCEPTION 'WORKSITE_PHOTOS: 3 contraintes CHECK attendues, % trouvées.', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'worksite_truck_photos_guard') THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: déclencheur de garde des photos absent.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'WorksitePhotoStatus' AND e.enumlabel = 'REJECTED') THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: valeur WorksitePhotoStatus.REJECTED absente.';
  END IF;
  IF EXISTS (SELECT 1 FROM "worksite_truck_photos" WHERE "approvedAt" IS NOT NULL OR "rejectRequestedAt" IS NOT NULL OR "rejectedAt" IS NOT NULL
             OR "trashRequestedById" IS NOT NULL) THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: aucune photo existante ne doit être validée ou rejetée par la migration.';
  END IF;
END $$;

COMMIT;
