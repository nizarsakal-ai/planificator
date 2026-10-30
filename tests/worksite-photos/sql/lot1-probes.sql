-- SPEC-WORKSITE-PHOTOS-001 Lot 1 — sondes SQL exécutées par tests/worksite-photos/migration.pg.test.ts dans une transaction annulée.
-- Chaque pg_temp.expect_fail doit être refusé par la base ; un refus manquant lève une exception et fait échouer le script.
BEGIN;
-- expect_fail(stmts, label, expected_constraint) : exécute les instructions dans un sous-bloc (savepoint) ; exige un refus et,
-- si `expected_constraint` est donné, que le refus porte ce nom de contrainte (SQLSTATE 23xxx) : un refus pour une autre raison échoue.
CREATE FUNCTION pg_temp.expect_fail(stmts text[], label text, expected_constraint text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
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
    IF expected_constraint IS NOT NULL AND (got_constraint <> expected_constraint OR got_state NOT LIKE '23%') THEN
      RAISE EXCEPTION 'REFUS INATTENDU [%] : attendu %, obtenu % (%) : %', label, expected_constraint, got_constraint, got_state, SQLERRM;
    END IF;
    RAISE NOTICE 'OK refus [%] (% %) : %', label, got_state, got_constraint, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'ATTENDU REFUS mais accepté : %', label;
END $$;
CREATE FUNCTION pg_temp.expect_fail(stmt text, label text, expected_constraint text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.expect_fail(ARRAY[stmt], label, expected_constraint);
END $$;

INSERT INTO "companies" ("id","name","slug","updatedAt") VALUES ('c1','C1','c1',now()),('c2','C2','c2',now());
INSERT INTO "users" ("id","email","password","role","companyId","updatedAt") VALUES ('u1','u1@example.test','x','ADMIN','c1',now()),('u2','u2@example.test','x','EMPLOYEE','c1',now());
INSERT INTO "clients" ("id","name","companyId","updatedAt") VALUES ('cl1','Lauralu','c1',now());
INSERT INTO "worksites" ("id","name","clientId","companyId","createdById","updatedAt") VALUES ('w1','Chantier A','cl1','c1','u1',now());
INSERT INTO "trucks" ("id","matricule","companyId","updatedAt") VALUES ('t1','AA-111-AA','c1',now()),('t2','BB-222-BB','c2',now());

-- Réservation : naît RESERVED
INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt")
VALUES ('r1','c1','11111111-1111-4111-8111-111111111111',repeat('a',64),'w1','t1','u1','p1','drive-file-1','22222222-2222-4222-8222-222222222222',now()+interval '15 minutes',now());
SELECT pg_temp.expect_fail($q$INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt","state")
VALUES ('rX','c1','33333333-3333-4333-8333-333333333333',repeat('a',64),'w1','t1','u1','pX','drive-file-X','22222222-2222-4222-8222-222222222222',now(),now(),'COMMITTED')$q$, 'réservation insérée hors RESERVED');
SELECT pg_temp.expect_fail($q$INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt")
VALUES ('r2','c1','11111111-1111-4111-8111-111111111111',repeat('b',64),'w1','t1','u1','p2','drive-file-2','22222222-2222-4222-8222-222222222222',now(),now())$q$, 'même clé idempotence même entreprise');
UPDATE "worksite_photo_upload_reservations" SET "state"='UPLOADING' WHERE "id"='r1';
SELECT pg_temp.expect_fail($q$UPDATE "worksite_photo_upload_reservations" SET "state"='CLOSED', "closedAt"=now(), "closeReason"='FILE_DELETED' WHERE "id"='r1'$q$, 'UPLOADING→CLOSED interdit');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_photo_upload_reservations" SET "driveFileId"='autre' WHERE "id"='r1'$q$, 'driveFileId figé');
SELECT pg_temp.expect_fail($q$DELETE FROM "worksite_photo_upload_reservations" WHERE "id"='r1'$q$, 'DELETE réservation');

-- Photo : insertion hors PENDING refusée ; cross-tenant refusé ; PENDING ok
SELECT pg_temp.expect_fail($q$INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","status","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot","sentAt","sentTo","sentMessageId","sentTransportKind","sentByAgent")
VALUES ('p1','c1','w1','t1','r1','BEFORE','SENT','drive-file-1','/Chantiers/x/2026-10-30/f.jpg','f.jpg','image/jpeg',10,repeat('c',64),'u1','Ouvrier',now(),'a@b.fr','<id@x>','smtp','hermes')$q$, 'photo insérée en SENT');
SELECT pg_temp.expect_fail($q$INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
VALUES ('p1','c1','w1','t2','r1','BEFORE','drive-file-1','/Chantiers/x/2026-10-30/f.jpg','f.jpg','image/jpeg',10,repeat('c',64),'u1','Ouvrier')$q$, 'engin d''un autre tenant (FK composite)');
INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
VALUES ('p1','c1','w1','t1','r1','BEFORE','drive-file-1','/Chantiers/x/2026-10-30/f.jpg','f.jpg','image/jpeg',10,repeat('c',64),'u1','Ouvrier');
UPDATE "worksite_photo_upload_reservations" SET "state"='COMMITTED' WHERE "id"='r1';
SELECT pg_temp.expect_fail($q$UPDATE "worksite_photo_upload_reservations" SET "state"='ABANDONED', "abandonedAt"=now() WHERE "id"='r1'$q$, 'COMMITTED terminal');

-- Cycle photo
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='DELETED', "trashRequestedAt"=now(), "trashedAt"=now() WHERE "id"='p1'$q$, 'PENDING→DELETED');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='SENT', "sentAt"=now() WHERE "id"='p1'$q$, 'SENT sans preuve');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='SENT', "sentAt"=now(), "sentTo"='  ', "sentMessageId"='<m@x>', "sentTransportKind"='smtp', "sentByAgent"='hermes' WHERE "id"='p1'$q$, 'SENT avec sentTo vide');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='SENT', "sentAt"=now(), "sentTo"='a@b.fr', "sentMessageId"='<m@x>', "sentTransportKind"='pigeon', "sentByAgent"='hermes' WHERE "id"='p1'$q$, 'transportKind hors motif');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "trashRequestedAt"=now() WHERE "id"='p1'$q$, 'trashRequestedAt en PENDING');
UPDATE "worksite_truck_photos" SET "status"='SENT', "sentAt"=now(), "sentTo"='a@b.fr', "sentMessageId"='<m@x>', "sentTransportKind"='provider:resend', "sentTransportRef"='re_1', "sentByAgent"='hermes' WHERE "id"='p1';
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "sentTo"='autre@b.fr' WHERE "id"='p1'$q$, 'preuve altérée après SENT');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "sentTransportRef"=NULL WHERE "id"='p1'$q$, 'transportRef effacé après SENT');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='PENDING', "sentAt"=NULL, "sentTo"=NULL, "sentMessageId"=NULL, "sentTransportKind"=NULL, "sentTransportRef"=NULL, "sentByAgent"=NULL WHERE "id"='p1'$q$, 'retour SENT→PENDING');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='DELETED', "trashedAt"=now() WHERE "id"='p1'$q$, 'DELETED sans trashRequestedAt');
UPDATE "worksite_truck_photos" SET "trashRequestedAt"=now() WHERE "id"='p1';
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "trashRequestedAt"=now()+interval '1 hour' WHERE "id"='p1'$q$, 'trashRequestedAt modifié');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "status"='DELETED', "trashedAt"="trashRequestedAt"-interval '1 second' WHERE "id"='p1'$q$, 'trashedAt antérieur à la demande');
UPDATE "worksite_truck_photos" SET "status"='DELETED', "trashedAt"=now() WHERE "id"='p1';
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "sentMessageId"='<autre>' WHERE "id"='p1'$q$, 'preuve altérée en DELETED');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_truck_photos" SET "purgedAt"="trashedAt"-interval '1 second' WHERE "id"='p1'$q$, 'purgedAt antérieur à trashedAt');
SELECT pg_temp.expect_fail($q$DELETE FROM "worksite_truck_photos" WHERE "id"='p1'$q$, 'DELETE photo');

-- Événements : ajout seul
INSERT INTO "worksite_photo_events" ("id","companyId","photoId","worksiteId","action","actorKind","actorId","actorNameSnapshot","outcome") VALUES ('e1','c1','p1','w1','UPLOADED','USER','u1','Ouvrier','DONE');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_photo_events" SET "outcome"='FAILED' WHERE "id"='e1'$q$, 'UPDATE événement');
SELECT pg_temp.expect_fail($q$DELETE FROM "worksite_photo_events" WHERE "id"='e1'$q$, 'DELETE événement');
SELECT pg_temp.expect_fail($q$INSERT INTO "worksite_photo_events" ("id","companyId","photoId","action","actorKind","actorId","actorNameSnapshot","outcome") VALUES ('e2','c2','p1','SENT','AGENT','hermes','Hermes','DONE')$q$, 'événement cross-tenant vers photo');

-- Réservation abandonnée : machine d'états de nettoyage
INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt")
VALUES ('r3','c1','44444444-4444-4444-8444-444444444444',repeat('d',64),'w1','t1','u1','p3','drive-file-3','22222222-2222-4222-8222-222222222222',now(),now());
UPDATE "worksite_photo_upload_reservations" SET "state"='ABANDONED', "abandonedAt"=now(), "attemptGeneration"=2 WHERE "id"='r3';
SELECT pg_temp.expect_fail($q$UPDATE "worksite_photo_upload_reservations" SET "state"='CLOSED', "closedAt"=now(), "closeReason"='FILE_DELETED' WHERE "id"='r3'$q$, 'ABANDONED→CLOSED FILE_DELETED sans CLEANING');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_photo_upload_reservations" SET "state"='CLOSED', "closedAt"=now(), "closeReason"='OPERATOR' WHERE "id"='r3'$q$, 'clôture OPERATOR sans motif');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_photo_upload_reservations" SET "state"='UPLOADING' WHERE "id"='r3'$q$, 'ABANDONED→UPLOADING (réutilisation)');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_photo_upload_reservations" SET "attemptGeneration"=1 WHERE "id"='r3'$q$, 'génération décroissante');
UPDATE "worksite_photo_upload_reservations" SET "state"='CLEANING', "attemptGeneration"=3 WHERE "id"='r3';
UPDATE "worksite_photo_upload_reservations" SET "state"='ABANDONED', "lastRemoteCheckAt"=now(), "remoteCheckCount"=1 WHERE "id"='r3';
UPDATE "worksite_photo_upload_reservations" SET "state"='CLEANING', "attemptGeneration"=4 WHERE "id"='r3';
UPDATE "worksite_photo_upload_reservations" SET "state"='CLOSED', "closedAt"=now(), "closeReason"='FILE_DELETED' WHERE "id"='r3';
SELECT pg_temp.expect_fail($q$UPDATE "worksite_photo_upload_reservations" SET "state"='ABANDONED' WHERE "id"='r3'$q$, 'CLOSED terminal');

-- Rattachement photo/réservation (L1-R1) : garde immédiate + contrainte différée dans les deux sens.
-- r4 : chemin de publication valide (photo puis COMMITTED) ; l'abandon d'une réservation rattachée est refusé aussitôt.
INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt")
VALUES ('r4','c1','55555555-5555-4555-8555-555555555555',repeat('e',64),'w1','t1','u1','p4','drive-file-4','22222222-2222-4222-8222-222222222222',now(),now());
UPDATE "worksite_photo_upload_reservations" SET "state"='UPLOADING' WHERE "id"='r4';
INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
VALUES ('p4','c1','w1','t1','r4','AFTER','drive-file-4','/Chantiers/x/2026-10-30/g.jpg','g.jpg','image/jpeg',10,repeat('f',64),'u1','Ouvrier');
SELECT pg_temp.expect_fail($q$UPDATE "worksite_photo_upload_reservations" SET "state"='ABANDONED', "abandonedAt"=now() WHERE "id"='r4'$q$, 'abandon d''une réservation rattachée à une photo (scénario L1-R1)', 'worksite_photo_upload_reservations_attached_photo_check');
UPDATE "worksite_photo_upload_reservations" SET "state"='COMMITTED' WHERE "id"='r4';
-- r5 : les contrôles différés, rendus immédiats dans le sous-bloc, refusent toute photo hors réservation COMMITTED et tout COMMITTED sans photo.
INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt")
VALUES ('r5','c1','66666666-6666-4666-8666-666666666666',repeat('9',64),'w1','t1','u1','p5','drive-file-5','22222222-2222-4222-8222-222222222222',now(),now());
SELECT pg_temp.expect_fail(ARRAY[$q$INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
VALUES ('p5','c1','w1','t1','r5','BEFORE','drive-file-5','/Chantiers/x/2026-10-30/h.jpg','h.jpg','image/jpeg',10,repeat('1',64),'u1','Ouvrier')$q$, 'SET CONSTRAINTS ALL IMMEDIATE'], 'photo rattachée à une réservation RESERVED', 'worksite_truck_photos_reservation_consistency_check');
UPDATE "worksite_photo_upload_reservations" SET "state"='UPLOADING' WHERE "id"='r5';
SELECT pg_temp.expect_fail(ARRAY[$q$INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
VALUES ('p5','c1','w1','t1','r5','BEFORE','drive-file-5','/Chantiers/x/2026-10-30/h.jpg','h.jpg','image/jpeg',10,repeat('1',64),'u1','Ouvrier')$q$, 'SET CONSTRAINTS ALL IMMEDIATE'], 'photo rattachée à une réservation UPLOADING (sans COMMITTED en fin de transaction)', 'worksite_truck_photos_reservation_consistency_check');
SELECT pg_temp.expect_fail(ARRAY[$q$UPDATE "worksite_photo_upload_reservations" SET "state"='COMMITTED' WHERE "id"='r5'$q$, 'SET CONSTRAINTS ALL IMMEDIATE'], 'COMMITTED sans photo rattachée', 'worksite_photo_upload_reservations_committed_photo_check');
SELECT pg_temp.expect_fail(ARRAY[$q$INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
VALUES ('p5','c1','w1','t1','r5','BEFORE','drive-file-AUTRE','/Chantiers/x/2026-10-30/h.jpg','h.jpg','image/jpeg',10,repeat('1',64),'u1','Ouvrier')$q$, $q$UPDATE "worksite_photo_upload_reservations" SET "state"='COMMITTED' WHERE "id"='r5'$q$, 'SET CONSTRAINTS ALL IMMEDIATE'], 'photo et réservation COMMITTED mais driveFileId divergent', 'worksite_truck_photos_reservation_consistency_check');
SELECT pg_temp.expect_fail(ARRAY[$q$INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
VALUES ('p5x','c1','w1','t1','r5','BEFORE','drive-file-5','/Chantiers/x/2026-10-30/h.jpg','h.jpg','image/jpeg',10,repeat('1',64),'u1','Ouvrier')$q$, $q$UPDATE "worksite_photo_upload_reservations" SET "state"='COMMITTED' WHERE "id"='r5'$q$, 'SET CONSTRAINTS ALL IMMEDIATE'], 'identifiant de photo différent du photoId réservé', 'worksite_truck_photos_reservation_consistency_check');
SELECT pg_temp.expect_fail(ARRAY[$q$INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
VALUES ('p5','c1','w1','t1','r5','BEFORE','drive-file-5','/Chantiers/x/2026-10-30/h.jpg','h.jpg','image/jpeg',10,repeat('1',64),'u2','Autre')$q$, $q$UPDATE "worksite_photo_upload_reservations" SET "state"='COMMITTED' WHERE "id"='r5'$q$, 'SET CONSTRAINTS ALL IMMEDIATE'], 'auteur de la photo différent de la réservation', 'worksite_truck_photos_reservation_consistency_check');
-- r6 : scénario exact de la revue Codex (UPLOADING, photo insérée, puis ABANDONED → CLEANING) refusé dès l'abandon.
INSERT INTO "worksite_photo_upload_reservations" ("id","companyId","idempotencyKey","requestHash","worksiteId","truckId","uploadedById","photoId","driveFileId","attemptOwner","leaseExpiresAt","updatedAt")
VALUES ('r6','c1','77777777-7777-4777-8777-777777777777',repeat('2',64),'w1','t1','u1','p6','drive-file-6','22222222-2222-4222-8222-222222222222',now(),now());
UPDATE "worksite_photo_upload_reservations" SET "state"='UPLOADING' WHERE "id"='r6';
INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
VALUES ('p6','c1','w1','t1','r6','BEFORE','drive-file-6','/Chantiers/x/2026-10-30/i.jpg','i.jpg','image/jpeg',10,repeat('3',64),'u1','Ouvrier');
SELECT pg_temp.expect_fail(ARRAY[$q$UPDATE "worksite_photo_upload_reservations" SET "state"='ABANDONED', "abandonedAt"=now() WHERE "id"='r6'$q$, $q$UPDATE "worksite_photo_upload_reservations" SET "state"='CLEANING' WHERE "id"='r6'$q$], 'photo rattachée puis réservation ABANDONED → CLEANING (reproduction L1-R1)', 'worksite_photo_upload_reservations_attached_photo_check');
UPDATE "worksite_photo_upload_reservations" SET "state"='COMMITTED' WHERE "id"='r6';
-- Photo vers une réservation CLOSED (r3) refusée ; les publications valides (r1/p1, r4/p4, r6/p6) passent le contrôle différé rendu immédiat.
SELECT pg_temp.expect_fail(ARRAY[$q$INSERT INTO "worksite_truck_photos" ("id","companyId","worksiteId","truckId","reservationId","phase","driveFileId","drivePath","originalFilename","mimeType","sizeBytes","sha256","uploadedById","uploadedByNameSnapshot")
VALUES ('p3','c1','w1','t1','r3','BEFORE','drive-file-3','/Chantiers/x/2026-10-30/j.jpg','j.jpg','image/jpeg',10,repeat('4',64),'u1','Ouvrier')$q$, 'SET CONSTRAINTS ALL IMMEDIATE'], 'photo rattachée à une réservation CLOSED', 'worksite_truck_photos_reservation_consistency_check');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

-- Dossiers : identité avec NULLS NOT DISTINCT
INSERT INTO "worksite_photo_drive_folders" ("id","companyId","driveFolderId","path") VALUES ('f-root','c1','folder-root','/Chantiers');
SELECT pg_temp.expect_fail($q$INSERT INTO "worksite_photo_drive_folders" ("id","companyId","driveFolderId","path") VALUES ('f-root2','c1','folder-root2','/Chantiers')$q$, 'deuxième racine même entreprise');
INSERT INTO "worksite_photo_drive_folders" ("id","companyId","worksiteId","driveFolderId","path") VALUES ('f-w1','c1','w1','folder-w1','/Chantiers/Lauralu-Chantier A~w1');
SELECT pg_temp.expect_fail($q$INSERT INTO "worksite_photo_drive_folders" ("id","companyId","worksiteId","driveFolderId","path") VALUES ('f-w1b','c1','w1','folder-w1b','/Chantiers/Lauralu-Chantier A~w1')$q$, 'deuxième dossier chantier');
INSERT INTO "worksite_photo_drive_folders" ("id","companyId","worksiteId","day","driveFolderId","path") VALUES ('f-d1','c1','w1','2026-10-30','folder-d1','/Chantiers/Lauralu-Chantier A~w1/2026-10-30');
SELECT pg_temp.expect_fail($q$INSERT INTO "worksite_photo_drive_folders" ("id","companyId","worksiteId","day","driveFolderId","path") VALUES ('f-d1b','c1','w1','2026-10-30','folder-d1b','/x')$q$, 'deuxième dossier jour');
SELECT pg_temp.expect_fail($q$INSERT INTO "worksite_photo_drive_folders" ("id","companyId","day","driveFolderId","path") VALUES ('f-bad','c1','2026-10-30','folder-bad','/x')$q$, 'jour sans chantier');
INSERT INTO "worksite_photo_drive_folders" ("id","companyId","worksiteId","day","driveFolderId","path") VALUES ('f-d2','c1','w1','2026-10-31','folder-d2','/Chantiers/Lauralu-Chantier A~w1/2026-10-31');

-- Suppression d'un chantier référencé refusée (RESTRICT)
SELECT pg_temp.expect_fail($q$DELETE FROM "worksites" WHERE "id"='w1'$q$, 'DELETE chantier référencé');
ROLLBACK;
SELECT 'PROBES TERMINÉES' AS resultat;
