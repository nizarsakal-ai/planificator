-- Fixtures HÉRITÉES SYNTHÉTIQUES (campagne de migration du mandat Codex §4.C.2) — schéma ANTÉRIEUR au Lot C (après 20261025210000).
-- Deux sociétés avec pièces ; brouillons FAC de deux années ; factures SENT/PAID sans paiements ; avoir total ancien (Lot B) ;
-- taux de TVA hors liste de saisie (8,5 %) ; devis sans colonnes C1 ; compteurs légaux au maximum de chaque série ;
-- une pièce émise volontairement INCOHÉRENTE (totaux ≠ lignes) pour le précontrôle d'intégrité. Aucune donnée réelle.
BEGIN;
INSERT INTO companies(id,name,slug,siret,address,email,"updatedAt") VALUES ('coA','Société A héritée','a','12345678900012','1 rue A','a@a.test',now()),('coB','Société B héritée','b','98765432100011','2 rue B','b@b.test',now());
INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('admA','a@x','x','ADMIN','coA',now()),('admB','b@x','x','ADMIN','coB',now());
INSERT INTO clients(id,"companyId",name,email,address,"updatedAt") VALUES ('clA','coA','Client A','ca@x.test','10 rue',now()),('clA2','coA','Client A2',NULL,NULL,now()),('clB','coB','Client B','cb@x.test','11 rue',now());
INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','admA','Chantier A1',now()),('wA2','coA','clA2','admA','Chantier A2',now()),('wB','coB','clB','admB','Chantier B1',now());
-- Devis Lot « pré-C » (sans jeton, sans remise) : un envoyé, un brouillon, un pour B.
INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"issueDate","validUntil","totalHT","totalVAT","totalTTC","createdById","updatedAt","sentAt")
VALUES ('qA1','coA','wA','clA','DEV-2025-0001','SENT','2025-11-02','2025-12-02',1000,200,1200,'admA',now(),'2025-11-02'),
       ('qA2','coA','wA2','clA2','DEV-2026-0001','DRAFT','2026-01-15','2026-02-14',500,100,600,'admA',now(),NULL),
       ('qB1','coB','wB','clB','DEV-2026-0001','SENT','2026-01-10','2026-02-09',300,60,360,'admB',now(),'2026-01-10');
INSERT INTO quote_lines(id,"quoteId",designation,unit,quantity,"unitPrice","vatRate","lineHT",position) VALUES
 ('qA1-l1','qA1','Prestation 2025','u',1,1000,20,1000,0),('qA2-l1','qA2','Prestation 2026','u',1,500,20,500,0),('qB1-l1','qB1','Prestation B','u',1,300,20,300,0);
-- Factures Lot B. FAC-2025-0001 PAID sans paiement (règlement constaté), taux hérité 8,5 % ; FAC-2025-0002 annulée par avoir total AV-2025-0001 ;
-- FAC-2025-0003 brouillon d'une année précédente ; FAC-2026-0001 SENT ; FAC-2026-0002 brouillon de l'année courante ; FAC-2025-0004 émise INCOHÉRENTE.
INSERT INTO invoices(id,"companyId","worksiteId","clientId","quoteId",number,status,kind,"issueDate","dueDate","totalHT","totalVAT","totalTTC","createdById","updatedAt","createdAt")
VALUES ('iA1','coA','wA','clA','qA1','FAC-2025-0001','DRAFT','INVOICE','2025-11-20','2025-12-20',100.00,8.50,108.50,'admA',now(),'2025-11-20'),
       ('iA2','coA','wA','clA',NULL,'FAC-2025-0002','DRAFT','INVOICE','2025-11-25','2025-12-25',200.00,40.00,240.00,'admA',now(),'2025-11-25'),
       ('iA3','coA','wA2','clA2',NULL,'FAC-2025-0003','DRAFT','INVOICE','2025-12-28','2026-01-27',50.00,10.00,60.00,'admA',now(),'2025-12-28'),
       ('iA4','coA','wA','clA',NULL,'FAC-2025-0004','DRAFT','INVOICE','2025-12-29','2026-01-28',100.00,20.00,999.00,'admA',now(),'2025-12-29'),
       ('iA5','coA','wA','clA',NULL,'FAC-2026-0001','DRAFT','INVOICE','2026-01-10','2026-02-09',300.00,60.00,360.00,'admA',now(),'2026-01-10'),
       ('iA6','coA','wA','clA',NULL,'FAC-2026-0002','DRAFT','INVOICE','2026-02-01','2026-03-03',80.00,16.00,96.00,'admA',now(),'2026-02-01'),
       ('iB1','coB','wB','clB','qB1','FAC-2026-0001','DRAFT','INVOICE','2026-01-20','2026-02-19',300.00,60.00,360.00,'admB',now(),'2026-01-20');
INSERT INTO invoice_lines(id,"invoiceId",designation,unit,quantity,"unitPrice","vatRate","lineHT",position) VALUES
 ('iA1-l','iA1','Prestation (taux hérité 8,5 %)','u',1,100,8.50,100,0),('iA2-l','iA2','Prestation','u',1,200,20,200,0),('iA3-l','iA3','Brouillon 2025','u',1,50,20,50,0),
 ('iA4-l','iA4','Incohérente','u',1,100,20,100,0),('iA5-l','iA5','Émise 2026','u',1,300,20,300,0),('iA6-l','iA6','Brouillon 2026','u',1,80,20,80,0),('iB1-l','iB1','B','u',1,300,20,300,0);
UPDATE invoices SET status='SENT', "sentAt"='2025-11-20' WHERE id IN ('iA1','iA2','iA4');
UPDATE invoices SET status='SENT', "sentAt"='2026-01-10' WHERE id IN ('iA5','iB1');
UPDATE invoices SET status='PAID', "paidAt"='2025-12-15' WHERE id='iA1';
-- Avoir total Lot B sur FAC-2025-0002 : annulation + copie exacte émise (invariants différés vérifiés au COMMIT).
UPDATE invoices SET status='CANCELLED' WHERE id='iA2';
INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,status,kind,"creditedInvoiceId","issueDate","totalHT","totalVAT","totalTTC","createdById","updatedAt","createdAt")
VALUES ('cnA2','coA','wA','clA','AV-2025-0001','DRAFT','CREDIT_NOTE','iA2','2025-12-01',200.00,40.00,240.00,'admA',now(),'2025-12-01');
INSERT INTO invoice_lines(id,"invoiceId",designation,unit,quantity,"unitPrice","vatRate","lineHT",position) VALUES ('cnA2-l','cnA2','Prestation','u',1,200,20,200,0);
UPDATE invoices SET status='SENT', "sentAt"='2025-12-01' WHERE id='cnA2';
INSERT INTO document_counters(id,"companyId",type,year,"lastValue") VALUES ('c1','coA','QUOTE',2025,1),('c2','coA','QUOTE',2026,1),('c3','coA','INVOICE',2025,4),('c4','coA','INVOICE',2026,2),('c5','coA','CREDIT_NOTE',2025,1),('c6','coB','QUOTE',2026,1),('c7','coB','INVOICE',2026,1);
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
