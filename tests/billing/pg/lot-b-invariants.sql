-- Lot B minimal — essais PostgreSQL automatisés (assertions). À exécuter sur une base jetable,
-- après application de toutes les migrations : psql -v ON_ERROR_STOP=1 -f lot-b-invariants.sql
-- Sortie attendue : une ligne PASS par essai puis « RESULTAT: N/N ». Toute anomalie lève une erreur.
\set ON_ERROR_STOP 1
SET client_min_messages = warning;

CREATE TEMP TABLE _r(n serial, name text, ok boolean, detail text);

-- expect_error : exécute sql dans une sous-transaction, force les contraintes différées, attend une erreur.
CREATE OR REPLACE FUNCTION pg_temp.expect_error(name text, sql text, pattern text) RETURNS void AS $$
DECLARE msg text;
BEGIN
  BEGIN
    EXECUTE sql;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
    RAISE EXCEPTION 'NO_ERROR';
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
  END;
  INSERT INTO _r(name, ok, detail) VALUES (name, msg <> 'NO_ERROR' AND msg ~ pattern, msg);
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.expect_ok(name text, sql text) RETURNS void AS $$
DECLARE msg text := 'ok';
BEGIN
  BEGIN
    EXECUTE sql;
    SET CONSTRAINTS ALL IMMEDIATE;
    SET CONSTRAINTS ALL DEFERRED;
  EXCEPTION WHEN OTHERS THEN
    msg := SQLERRM;
  END;
  INSERT INTO _r(name, ok, detail) VALUES (name, msg = 'ok', msg);
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.check(name text, cond boolean, detail text) RETURNS void AS $$
BEGIN INSERT INTO _r(name, ok, detail) VALUES (name, coalesce(cond, false), detail); END $$ LANGUAGE plpgsql;

-- Données fictives
INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now());
INSERT INTO users(id,email,password,"updatedAt") VALUES ('u','u@x','x',now());
INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('clA','coA','ClA',now()),('clB','coB','ClB',now());
INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','u','WA',now()),('wB','coB','clB','u','WB',now());

CREATE OR REPLACE FUNCTION pg_temp.new_invoice(i text, co text, w text, cl text) RETURNS void AS $$
BEGIN
  INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,"totalHT","totalVAT","totalTTC")
  VALUES (i, co, w, cl, 'FAC-'||i, 'u', now(), 'DRAFT', 100, 20, 120);
  INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('l-'||i, i, 'L', 1, 100, 20, 100);
END $$ LANGUAGE plpgsql;

DO $$ BEGIN
  PERFORM pg_temp.expect_error('T01 création directe hors brouillon refusée',
    $q$INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status) VALUES ('x','coA','wA','clA','FAC-x','u',now(),'SENT')$q$, 'créée en brouillon');
  PERFORM pg_temp.new_invoice('i1','coA','wA','clA');
  PERFORM pg_temp.expect_ok('T02 brouillon modifiable', $q$UPDATE invoices SET notes='n' WHERE id='i1'$q$);
  PERFORM pg_temp.expect_error('T03 émission sans date d''envoi refusée', $q$UPDATE invoices SET status='SENT' WHERE id='i1'$q$, 'date d''envoi');
  PERFORM pg_temp.expect_error('T04 nature non modifiable (brouillon)', $q$UPDATE invoices SET kind='CREDIT_NOTE', "creditedInvoiceId"='i1' WHERE id='i1'$q$, 'identité|nature|invoices_kind_credited_ck');
  PERFORM pg_temp.expect_error('T05 facture avec référence d''avoir refusée (CHECK)', $q$INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,"creditedInvoiceId") VALUES ('y','coA','wA','clA','FAC-y','u',now(),'DRAFT','i1')$q$, 'invoices_kind_credited_ck');
END $$;

UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='i1';

DO $$ BEGIN
  PERFORM pg_temp.expect_error('T06 retour SENT -> DRAFT refusé', $q$UPDATE invoices SET status='DRAFT', "sentAt"=NULL WHERE id='i1'$q$, 'interdite');
  PERFORM pg_temp.expect_error('T07 montant d''une facture émise figé', $q$UPDATE invoices SET "totalHT"=1 WHERE id='i1'$q$, 'non modifiable');
  PERFORM pg_temp.expect_error('T08 date d''envoi figée', $q$UPDATE invoices SET "sentAt"=now()+interval '1 day' WHERE id='i1'$q$, 'non modifiable');
  PERFORM pg_temp.expect_error('T09 société non modifiable', $q$UPDATE invoices SET "companyId"='coB' WHERE id='i1'$q$, 'société');
  PERFORM pg_temp.expect_error('T10 ajout de ligne refusé', $q$INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('z','i1','Z',1,1,20,1)$q$, 'lignes');
  PERFORM pg_temp.expect_error('T11 modification de ligne refusée', $q$UPDATE invoice_lines SET designation='X' WHERE id='l-i1'$q$, 'lignes');
  PERFORM pg_temp.expect_error('T12 suppression de ligne refusée', $q$DELETE FROM invoice_lines WHERE id='l-i1'$q$, 'lignes');
  PERFORM pg_temp.new_invoice('i2','coA','wA','clA');
  PERFORM pg_temp.expect_error('T13 déplacement d''une ligne vers une facture émise refusé', $q$UPDATE invoice_lines SET "invoiceId"='i1' WHERE id='l-i2'$q$, 'lignes');
  PERFORM pg_temp.expect_error('T14 suppression d''une facture émise refusée', $q$DELETE FROM invoices WHERE id='i1'$q$, 'supprimée');
  PERFORM pg_temp.expect_error('T15 annulation sans avoir refusée au COMMIT', $q$UPDATE invoices SET status='CANCELLED' WHERE id='i1'$q$, 'INVOICE_CANCEL_WITHOUT_CREDIT_NOTE');
  PERFORM pg_temp.expect_error('T16 paiement sans date refusé', $q$UPDATE invoices SET status='PAID' WHERE id='i1'$q$, 'paiement');
END $$;

UPDATE invoices SET status='PAID', "paidAt"=now() WHERE id='i1';

DO $$ BEGIN
  PERFORM pg_temp.expect_error('T17 date de paiement figée', $q$UPDATE invoices SET "paidAt"=now()+interval '1 day' WHERE id='i1'$q$, 'paiement');
  PERFORM pg_temp.expect_error('T18 avoir aux montants différents refusé', $q$
    UPDATE invoices SET status='CANCELLED' WHERE id='i1';
    INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('avbad','coA','wA','clA','AV-bad','u',now(),'DRAFT','CREDIT_NOTE','i1',1,0.2,1.2);
    UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='avbad'$q$, 'CREDIT_NOTE_INVALID|INVOICE_CANCEL_WITHOUT_CREDIT_NOTE');
  PERFORM pg_temp.expect_error('T19 avoir laissé en brouillon refusé au COMMIT', $q$
    UPDATE invoices SET status='CANCELLED' WHERE id='i1';
    INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('avdraft','coA','wA','clA','AV-d','u',now(),'DRAFT','CREDIT_NOTE','i1',100,20,120)$q$, 'CREDIT_NOTE_INVALID|INVOICE_CANCEL_WITHOUT_CREDIT_NOTE');
  PERFORM pg_temp.new_invoice('iB','coB','wB','clB');
  UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='iB';
  PERFORM pg_temp.expect_error('T20 avoir vers une facture d''une autre société refusé', $q$
    UPDATE invoices SET status='CANCELLED' WHERE id='iB';
    INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('avx','coA','wA','clA','AV-x','u',now(),'DRAFT','CREDIT_NOTE','iB',100,20,120);
    UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='avx'$q$, 'CREDIT_NOTE_INVALID|INVOICE_CANCEL_WITHOUT_CREDIT_NOTE');
  PERFORM pg_temp.expect_ok('T21 séquence d''avoir valide (annulation, avoir brouillon + lignes, émission)', $q$
    UPDATE invoices SET status='CANCELLED' WHERE id='i1';
    INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('av1','coA','wA','clA','AV-1','u',now(),'DRAFT','CREDIT_NOTE','i1',100,20,120);
    INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('l-av1','av1','L',1,100,20,100);
    UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='av1'$q$);
  PERFORM pg_temp.check('T22 état après avoir : facture CANCELLED, avoir SENT',
    (SELECT status FROM invoices WHERE id='i1')='CANCELLED' AND (SELECT status FROM invoices WHERE id='av1')='SENT', 'états');
  PERFORM pg_temp.expect_error('T23 second avoir refusé', $q$INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('av2','coA','wA','clA','AV-2','u',now(),'DRAFT','CREDIT_NOTE','i1',100,20,120)$q$, 'invoices_creditedInvoiceId_key');
  PERFORM pg_temp.expect_error('T24 un avoir ne s''annule pas', $q$UPDATE invoices SET status='CANCELLED' WHERE id='av1'$q$, 'interdite');
  PERFORM pg_temp.expect_error('T24b un avoir ne se paie pas', $q$UPDATE invoices SET status='PAID', "paidAt"=now() WHERE id='av1'$q$, 'interdite');
  PERFORM pg_temp.expect_error('T25 annulée -> payée refusé', $q$UPDATE invoices SET status='PAID' WHERE id='i1'$q$, 'interdite');
  -- Contenu de l'avoir : copie exacte des lignes exigée (facture d'origine à 2 lignes).
  PERFORM pg_temp.new_invoice('k','coA','wA','clA');
  INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT",position) VALUES ('l-k2','k','L2',1,0,10,0,1);
  UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='k';
  PERFORM pg_temp.expect_error('T30 avoir sans aucune ligne refusé', $q$
    UPDATE invoices SET status='CANCELLED' WHERE id='k';
    INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('ak','coA','wA','clA','AV-k','u',now(),'DRAFT','CREDIT_NOTE','k',100,20,120);
    UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='ak'$q$, 'CREDIT_NOTE_INVALID|INVOICE_CANCEL_WITHOUT_CREDIT_NOTE');
  PERFORM pg_temp.expect_error('T31 avoir avec une ligne manquante refusé', $q$
    UPDATE invoices SET status='CANCELLED' WHERE id='k';
    INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('ak','coA','wA','clA','AV-k','u',now(),'DRAFT','CREDIT_NOTE','k',100,20,120);
    INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('x1','ak','L',1,100,20,100);
    UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='ak'$q$, 'CREDIT_NOTE_INVALID|INVOICE_CANCEL_WITHOUT_CREDIT_NOTE');
  PERFORM pg_temp.expect_error('T32 avoir avec une ligne en plus refusé', $q$
    UPDATE invoices SET status='CANCELLED' WHERE id='k';
    INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('ak','coA','wA','clA','AV-k','u',now(),'DRAFT','CREDIT_NOTE','k',100,20,120);
    INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT",position) VALUES ('x1','ak','L',1,100,20,100,0),('x2','ak','L2',1,0,10,0,1),('x3','ak','L3',1,0,10,0,2);
    UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='ak'$q$, 'CREDIT_NOTE_INVALID|INVOICE_CANCEL_WITHOUT_CREDIT_NOTE');
  PERFORM pg_temp.expect_error('T33 avoir aux mêmes totaux mais taux de TVA différent refusé', $q$
    UPDATE invoices SET status='CANCELLED' WHERE id='k';
    INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('ak','coA','wA','clA','AV-k','u',now(),'DRAFT','CREDIT_NOTE','k',100,20,120);
    INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT",position) VALUES ('x1','ak','L',1,100,20,100,0),('x2','ak','L2',1,0,5.5,0,1);
    UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='ak'$q$, 'CREDIT_NOTE_INVALID|INVOICE_CANCEL_WITHOUT_CREDIT_NOTE');
  PERFORM pg_temp.expect_error('T34 avoir avec désignation différente refusé', $q$
    UPDATE invoices SET status='CANCELLED' WHERE id='k';
    INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('ak','coA','wA','clA','AV-k','u',now(),'DRAFT','CREDIT_NOTE','k',100,20,120);
    INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT",position) VALUES ('x1','ak','AUTRE',1,100,20,100,0),('x2','ak','L2',1,0,10,0,1);
    UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='ak'$q$, 'CREDIT_NOTE_INVALID|INVOICE_CANCEL_WITHOUT_CREDIT_NOTE');
  INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('clA2','coA','ClA2',now());
  PERFORM pg_temp.expect_error('T35 avoir vers un autre client refusé', $q$
    UPDATE invoices SET status='CANCELLED' WHERE id='k';
    INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('ak','coA','wA','clA2','AV-k','u',now(),'DRAFT','CREDIT_NOTE','k',100,20,120);
    INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT",position) VALUES ('x1','ak','L',1,100,20,100,0),('x2','ak','L2',1,0,10,0,1);
    UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='ak'$q$, 'CREDIT_NOTE_INVALID|INVOICE_CANCEL_WITHOUT_CREDIT_NOTE');
  PERFORM pg_temp.check('T36 rollback complet après refus : facture toujours SENT, aucun avoir',
    (SELECT status FROM invoices WHERE id='k')='SENT' AND NOT EXISTS (SELECT 1 FROM invoices WHERE "creditedInvoiceId"='k'), 'état');
  PERFORM pg_temp.expect_ok('T37 avoir copie exacte (2 lignes) accepté', $q$
    UPDATE invoices SET status='CANCELLED' WHERE id='k';
    INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"creditedInvoiceId","totalHT","totalVAT","totalTTC") VALUES ('ak','coA','wA','clA','AV-k','u',now(),'DRAFT','CREDIT_NOTE','k',100,20,120);
    INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT",position) VALUES ('x1','ak','L',1,100,20,100,0),('x2','ak','L2',1,0,10,0,1);
    UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='ak'$q$);
  PERFORM pg_temp.expect_error('T38 brouillon créé avec des dates refusé', $q$INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,"sentAt") VALUES ('d1','coA','wA','clA','FAC-d1','u',now(),'DRAFT',now())$q$, 'brouillon');
  PERFORM pg_temp.expect_ok('T26 abandon d''un brouillon sans avoir', $q$UPDATE invoices SET status='CANCELLED' WHERE id='i2'$q$);
  PERFORM pg_temp.new_invoice('i3','coA','wA','clA');
  PERFORM pg_temp.expect_ok('T27 suppression d''un brouillon (et de ses lignes)', $q$DELETE FROM invoice_lines WHERE "invoiceId"='i3'; DELETE FROM invoices WHERE id='i3'$q$);
  PERFORM pg_temp.expect_error('T28 suppression d''un chantier facturé refusée', $q$DELETE FROM worksites WHERE id='wA'$q$, 'foreign key');
  PERFORM pg_temp.expect_error('T29 suppression d''une société facturée refusée', $q$DELETE FROM companies WHERE id='coA'$q$, 'foreign key');
END $$;

SELECT CASE WHEN ok THEN 'PASS ' ELSE 'FAIL ' END || name || CASE WHEN ok THEN '' ELSE ' — ' || detail END FROM _r ORDER BY n;
SELECT 'RESULTAT: ' || count(*) FILTER (WHERE ok) || '/' || count(*) FROM _r;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM _r WHERE NOT ok) THEN RAISE EXCEPTION 'ECHECS: %', (SELECT count(*) FROM _r WHERE NOT ok); END IF; END $$;
