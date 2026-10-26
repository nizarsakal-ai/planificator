-- Variante NON COHÉRENTE (précontrôle S1, migration 20261026062000), appliquée après les correctives jusqu'à 061000 :
-- facture de solde ÉMISE liée à un devis, avec une liaison d'acompte (invoice_deposit_deductions) mais SANS ligne de déduction.
-- Construction dans l'ordre permis par les déclencheurs : pièces créées en brouillon, liaison posée sur le solde brouillon, puis émissions.
BEGIN;
INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"issueDate","validUntil","totalHT","totalVAT","totalTTC","createdById","updatedAt","sentAt","acceptedAt")
VALUES ('qORPH','coA','wA','clA','DEV-2026-0900','ACCEPTED','2026-02-01','2026-12-31',1000.00,200.00,1200.00,'admA',now(),'2026-02-01','2026-02-02');
INSERT INTO quote_lines(id,"quoteId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('qORPH-l','qORPH','Travaux',1,1000,20,1000);
INSERT INTO invoices(id,"companyId","worksiteId","clientId","quoteId",number,status,kind,"issueDate","totalHT","totalVAT","totalTTC","createdById","updatedAt","createdAt")
VALUES ('depORPH','coA','wA','clA','qORPH','FAC-2026-0901','DRAFT','DEPOSIT','2026-02-05',300.00,60.00,360.00,'admA',now(),'2026-02-05'),
       ('finORPH','coA','wA','clA','qORPH','FAC-2026-0902','DRAFT','INVOICE','2026-02-20',1000.00,200.00,1200.00,'admA',now(),'2026-02-20');
INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('depORPH-l','depORPH','Acompte 30 %',1,300,20,300),('finORPH-l','finORPH','Travaux',1,1000,20,1000);
UPDATE invoices SET status='SENT', "sentAt"='2026-02-05T10:00:00Z' WHERE id='depORPH';
INSERT INTO invoice_deposit_deductions(id,"companyId","finalInvoiceId","depositInvoiceId","amountTTCCents") VALUES ('dedORPH','coA','finORPH','depORPH',36000);
UPDATE invoices SET status='SENT', "sentAt"='2026-02-20T10:00:00Z' WHERE id='finORPH';
COMMIT;
