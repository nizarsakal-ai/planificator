-- LOT-ADMIN-REVIEW — sondes SQL de 20261031090000_worksite_photos_admin_review, exécutées par
-- tests/worksite-photos/admin-review-migration.pg.test.ts dans une transaction ANNULÉE (aucune donnée ne reste).
-- Chaque pg_temp.expect_fail doit être refusé par la base AVEC la contrainte attendue ; chaque pg_temp.expect_true doit être vrai.
-- Données entièrement synthétiques.
BEGIN;
CREATE FUNCTION pg_temp.expect_fail(stmts text[], label text, expected_constraint text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  stmt text;
  got_constraint text;
  got_state text;
BEGIN
  BEGIN
    FOREACH stmt IN ARRAY stmts LOOP
      EXECUTE stmt;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got_constraint = CONSTRAINT_NAME, got_state = RETURNED_SQLSTATE;
    IF got_constraint IS DISTINCT FROM expected_constraint OR got_state NOT LIKE '23%' THEN
      RAISE EXCEPTION 'REFUS INATTENDU [%] : attendu %, obtenu % (%) : %', label, expected_constraint, got_constraint, got_state, SQLERRM;
    END IF;
    RAISE NOTICE 'OK refus [%] (% %)', label, got_state, got_constraint;
    RETURN;
  END;
  RAISE EXCEPTION 'ATTENDU REFUS mais accepté : %', label;
END $$;
CREATE FUNCTION pg_temp.expect_fail(stmt text, label text, expected_constraint text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.expect_fail(ARRAY[stmt], label, expected_constraint);
END $$;
CREATE FUNCTION pg_temp.expect_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'ATTENDU VRAI : %', label; END IF;
  RAISE NOTICE 'OK [%]', label;
END $$;
-- Publie une photo PENDING synthétique (réservation RESERVED → UPLOADING → photo + COMMITTED).
CREATE FUNCTION pg_temp.publish(p text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format($i$INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt")
    VALUES (%L,'rv-c1',gen_random_uuid(),repeat('a',64),'rv-w1','rv-t1','rv-u1',%L,%L,gen_random_uuid(),now()+interval '15 minutes',now())$i$, 'r-' || p, p, 'drive-' || p);
  EXECUTE format($i$UPDATE "worksite_photo_upload_reservations" SET "state"='UPLOADING' WHERE "id"=%L$i$, 'r-' || p);
  EXECUTE format($i$INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
    VALUES (%L,'rv-c1','rv-w1','rv-t1',%L,'BEFORE',%L,'/Chantiers/x/2026-10-31/f.jpg','f.jpg','image/jpeg',10,repeat('c',64),'rv-u1','Ouvrier test')$i$, p, 'r-' || p, 'drive-' || p);
  EXECUTE format($i$UPDATE "worksite_photo_upload_reservations" SET "state"='COMMITTED' WHERE "id"=%L$i$, 'r-' || p);
END $$;

INSERT INTO "companies" ("id","name","slug","updatedAt") VALUES ('rv-c1','RV C1','rv-c1',now());
INSERT INTO "users" ("id","email","password","role","companyId","updatedAt") VALUES ('rv-u1','rv-u1@example.test','x','SUPER_ADMIN','rv-c1',now());
INSERT INTO "clients" ("id","name","companyId","updatedAt") VALUES ('rv-cl1','Client test','rv-c1',now());
INSERT INTO "worksites" ("id","name","clientId","companyId","createdById","updatedAt") VALUES ('rv-w1','Chantier test','rv-cl1','rv-c1','rv-u1',now());
INSERT INTO "trucks" ("id","matricule","companyId","updatedAt") VALUES ('rv-t1','ZZ-000-ZZ','rv-c1',now());

-- 1. Insertion : une photo naît sans validation ni rejet.
INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt")
VALUES ('r-pi','rv-c1',gen_random_uuid(),repeat('a',64),'rv-w1','rv-t1','rv-u1','pi','drive-pi',gen_random_uuid(),now()+interval '15 minutes',now());
UPDATE "worksite_photo_upload_reservations" SET "state"='UPLOADING' WHERE "id"='r-pi';
SELECT pg_temp.expect_fail($q$INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot","approvedAt","approvedById","approvedByNameSnapshot")
VALUES ('pi','rv-c1','rv-w1','rv-t1','r-pi','BEFORE','drive-pi','/x','f.jpg','image/jpeg',10,repeat('c',64),'rv-u1','Ouvrier test',now(),'rv-u1','Admin')$q$, 'insertion déjà validée', 'worksite_truck_photos_insert_review_check');
SELECT pg_temp.expect_fail($q$INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot","rejectRequestedAt","rejectRequestedById","rejectRequestedByNameSnapshot")
VALUES ('pi','rv-c1','rv-w1','rv-t1','r-pi','BEFORE','drive-pi','/x','f.jpg','image/jpeg',10,repeat('c',64),'rv-u1','Ouvrier test',now(),'rv-u1','Admin')$q$, 'insertion déjà en rejet', 'worksite_truck_photos_insert_review_check');

-- 2. Validation interne : attribuée, horodatée par la base, figée ; statut inchangé (PENDING = non envoyée).
SELECT pg_temp.publish('pa');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "approvedAt"=now() WHERE "id"='pa'$q$, 'validation sans auteur', 'worksite_truck_photos_review_values_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "approvedAt"=now(), "approvedById"='  ', "approvedByNameSnapshot"='Admin' WHERE "id"='pa'$q$, 'validation auteur vide', 'worksite_truck_photos_review_values_check');
UPDATE "worksite_truck_photos" SET "approvedAt"='2000-01-01T00:00:00Z', "approvedById"='rv-u1', "approvedByNameSnapshot"='Admin test' WHERE "id"='pa';
SELECT pg_temp.expect_true((SELECT "approvedAt" > '2020-01-01'::timestamptz AND "status"::text = 'PENDING' FROM "worksite_truck_photos" WHERE "id"='pa'), 'horodatage de validation posé par la base, statut toujours PENDING');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "approvedById"='autre' WHERE "id"='pa'$q$, 'auteur de validation modifié', 'worksite_truck_photos_approval_frozen_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "approvedAt"=NULL, "approvedById"=NULL, "approvedByNameSnapshot"=NULL WHERE "id"='pa'$q$, 'validation effacée', 'worksite_truck_photos_approval_frozen_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='SENT' WHERE "id"='pa'$q$, 'validation ≠ envoi : SENT exige toujours la preuve', 'worksite_truck_photos_sent_check');

-- 3. Rejet en deux phases.
SELECT pg_temp.publish('pr');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='REJECTED', "rejectedAt"=now() WHERE "id"='pr'$q$, 'REJECTED sans intention', 'worksite_truck_photos_reject_two_phase_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='REJECTED', "rejectRequestedAt"=now(), "rejectRequestedById"='rv-u1', "rejectRequestedByNameSnapshot"='Admin test', "rejectedAt"=now() WHERE "id"='pr'$q$, 'intention et finalisation dans la même instruction', 'worksite_truck_photos_reject_two_phase_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "rejectedAt"=now() WHERE "id"='pr'$q$, 'rejectedAt sur une photo PENDING', 'worksite_truck_photos_reject_timeline_check');
UPDATE "worksite_truck_photos" SET "rejectRequestedAt"='2000-01-01T00:00:00Z', "rejectRequestedById"='rv-u1', "rejectRequestedByNameSnapshot"='Admin test' WHERE "id"='pr';
SELECT pg_temp.expect_true((SELECT "rejectRequestedAt" > '2020-01-01'::timestamptz AND "status"::text = 'PENDING' FROM "worksite_truck_photos" WHERE "id"='pr'), 'intention horodatée par la base, photo toujours PENDING');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "approvedAt"=now(), "approvedById"='rv-u1', "approvedByNameSnapshot"='Admin test' WHERE "id"='pr'$q$, 'validation après intention de rejet', 'worksite_truck_photos_approval_state_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='SENT', "sentAt"=now(), "sentTo"='a@b.fr', "sentMessageId"='<m@x>', "sentTransportKind"='smtp', "sentByAgent"='hermes' WHERE "id"='pr'$q$, 'envoi après intention de rejet', 'worksite_truck_photos_reject_blocks_send_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "rejectRequestedById"='autre' WHERE "id"='pr'$q$, 'auteur de l''intention modifié', 'worksite_truck_photos_reject_frozen_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='REJECTED' WHERE "id"='pr'$q$, 'REJECTED sans corbeille confirmée', 'worksite_truck_photos_rejected_check');
UPDATE "worksite_truck_photos" SET "status"='REJECTED', "rejectedAt"='2000-01-01T00:00:00Z' WHERE "id"='pr';
SELECT pg_temp.expect_true((SELECT "rejectedAt" >= "rejectRequestedAt" FROM "worksite_truck_photos" WHERE "id"='pr'), 'finalisation horodatée par la base, après l''intention');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='PENDING', "rejectedAt"=NULL WHERE "id"='pr'$q$, 'REJECTED terminal', 'worksite_truck_photos_transition_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='SENT', "sentAt"=now(), "sentTo"='a@b.fr', "sentMessageId"='<m@x>', "sentTransportKind"='smtp', "sentByAgent"='hermes' WHERE "id"='pr'$q$, 'REJECTED → SENT', 'worksite_truck_photos_transition_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "sentTo"='a@b.fr' WHERE "id"='pr'$q$, 'champ de preuve sur REJECTED', 'worksite_truck_photos_rejected_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "rejectedAt"=now()+interval '1 hour' WHERE "id"='pr'$q$, 'rejectedAt modifié', 'worksite_truck_photos_timestamps_monotonic_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "approvedAt"=now(), "approvedById"='rv-u1', "approvedByNameSnapshot"='Admin test' WHERE "id"='pr'$q$, 'validation d''une photo rejetée', 'worksite_truck_photos_approval_state_check');
SELECT pg_temp.expect_fail($q$DELETE FROM "worksite_truck_photos" WHERE "id"='pr'$q$, 'DELETE SQL toujours refusé', 'worksite_truck_photos_no_delete_check');

-- 4. Photo validée puis rejetée : autorisé (changement d'avis avant envoi), la validation reste en historique.
UPDATE "worksite_truck_photos" SET "rejectRequestedAt"=now(), "rejectRequestedById"='rv-u1', "rejectRequestedByNameSnapshot"='Admin test' WHERE "id"='pa';
UPDATE "worksite_truck_photos" SET "status"='REJECTED', "rejectedAt"=now() WHERE "id"='pa';
SELECT pg_temp.expect_true((SELECT "approvedAt" IS NOT NULL AND "status"::text = 'REJECTED' FROM "worksite_truck_photos" WHERE "id"='pa'), 'validée puis rejetée : validation conservée');

-- 5. Legacy : une photo SENT sans validation reste sans validation ; aucune approbation ni rejet après envoi.
SELECT pg_temp.publish('ps');
UPDATE "worksite_truck_photos" SET "status"='SENT', "sentAt"=now(), "sentTo"='a@b.fr', "sentMessageId"='<m@x>', "sentTransportKind"='smtp', "sentByAgent"='hermes' WHERE "id"='ps';
SELECT pg_temp.expect_true((SELECT "approvedAt" IS NULL FROM "worksite_truck_photos" WHERE "id"='ps'), 'SENT legacy : validation non tracée, laissée NULL');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "approvedAt"=now(), "approvedById"='rv-u1', "approvedByNameSnapshot"='Admin test' WHERE "id"='ps'$q$, 'approbation historique inventée après envoi', 'worksite_truck_photos_approval_state_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "rejectRequestedAt"=now(), "rejectRequestedById"='rv-u1', "rejectRequestedByNameSnapshot"='Admin test' WHERE "id"='ps'$q$, 'rejet après envoi', 'worksite_truck_photos_reject_state_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='REJECTED', "rejectedAt"=now() WHERE "id"='ps'$q$, 'SENT → REJECTED', 'worksite_truck_photos_transition_check');

-- 6. Règles du Lot 1 conservées par la fonction remplacée.
SELECT pg_temp.publish('pl');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='DELETED', "trashRequestedAt"=now(), "trashedAt"=now() WHERE "id"='pl'$q$, 'PENDING→DELETED', 'worksite_truck_photos_transition_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "driveFileId"='autre' WHERE "id"='pl'$q$, 'identité figée', 'worksite_truck_photos_immutable_identity_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "trashRequestedAt"=now() WHERE "id"='pl'$q$, 'trashRequestedAt en PENDING (Lot 1)', 'worksite_truck_photos_pending_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "trashRequestedAt"=now(), "trashRequestedById"='rv-u1', "trashRequestedByNameSnapshot"='Admin test' WHERE "id"='pl'$q$, 'suppression après envoi demandée sur une photo PENDING', 'worksite_truck_photos_pending_check');

-- 7. Suppression APRÈS envoi : cycle existant SENT → DELETED, demande attribuée et figée, preuve d'envoi intacte.
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "trashRequestedById"='rv-u1', "trashRequestedByNameSnapshot"='Admin test' WHERE "id"='ps'$q$, 'auteur sans demande', 'worksite_truck_photos_review_values_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "trashRequestedAt"=now(), "trashRequestedById"='rv-u1', "trashRequestedByNameSnapshot"=' ' WHERE "id"='ps'$q$, 'demande avec nom d''auteur vide', 'worksite_truck_photos_review_values_check');
UPDATE "worksite_truck_photos" SET "trashRequestedAt"=clock_timestamp(), "trashRequestedById"='rv-u1', "trashRequestedByNameSnapshot"='Admin test' WHERE "id"='ps';
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "trashRequestedById"='autre' WHERE "id"='ps'$q$, 'auteur de la demande modifié', 'worksite_truck_photos_trash_attribution_check');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "rejectRequestedAt"=now(), "rejectRequestedById"='rv-u1', "rejectRequestedByNameSnapshot"='Admin test' WHERE "id"='ps'$q$, 'photo envoyée jamais mise en rejet', 'worksite_truck_photos_reject_state_check');
UPDATE "worksite_truck_photos" SET "status"='DELETED', "trashedAt"=clock_timestamp() WHERE "id"='ps';
SELECT pg_temp.expect_true((SELECT "status"::text = 'DELETED' AND "sentTo" = 'a@b.fr' AND "trashRequestedById" = 'rv-u1' AND "approvedAt" IS NULL FROM "worksite_truck_photos" WHERE "id"='ps'), 'DELETED : preuve d''envoi et auteur de la demande conservés, aucune validation inventée');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "trashRequestedByNameSnapshot"='Autre nom' WHERE "id"='ps'$q$, 'auteur figé après DELETED', 'worksite_truck_photos_trash_attribution_check');
SELECT pg_temp.publish('ph');
UPDATE "worksite_truck_photos" SET "status"='SENT', "sentAt"=now(), "sentTo"='a@b.fr', "sentMessageId"='<h@x>', "sentTransportKind"='smtp', "sentByAgent"='hermes' WHERE "id"='ph';
UPDATE "worksite_truck_photos" SET "trashRequestedAt"=clock_timestamp() WHERE "id"='ph';
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "trashRequestedById"='rv-u1', "trashRequestedByNameSnapshot"='Admin test' WHERE "id"='ph'$q$, 'auteur ajouté après coup à une demande existante', 'worksite_truck_photos_trash_attribution_check');
ROLLBACK;
SELECT 'PROBES TERMINÉES' AS resultat;
