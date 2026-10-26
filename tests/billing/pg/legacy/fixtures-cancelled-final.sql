-- Variante HÉRITÉE du cas T1 (reprise de la migration 20261026064000), appliquée après les correctives jusqu'à 063000 :
-- devis accepté, acompte ÉMIS, facture de solde ÉMISE avec déduction (liaison + ligne), puis ANNULÉE par un avoir total (copie exacte).
-- Avant 064000 la déduction restait active et immuable (acompte bloqué) ; la reprise doit la LIBÉRER (releasedAt) sans la supprimer,
-- malgré le garde C3 qui refuse tout UPDATE — ordre garde/reprise prouvé par ce scénario.
BEGIN;
INSERT INTO quotes(id,"companyId","worksiteId","clientId",number,status,"issueDate","validUntil","totalHT","totalVAT","totalTTC","createdById","updatedAt","sentAt","acceptedAt")
VALUES ('qCF','coA','wA','clA','DEV-2026-0910','ACCEPTED','2026-02-01','2026-12-31',1000.00,200.00,1200.00,'admA',now(),'2026-02-01','2026-02-02');
INSERT INTO quote_lines(id,"quoteId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('qCF-l','qCF','Travaux',1,1000,20,1000);
INSERT INTO invoices(id,"companyId","worksiteId","clientId","quoteId",number,status,kind,"issueDate","totalHT","totalVAT","totalTTC","createdById","updatedAt","createdAt")
VALUES ('depCF','coA','wA','clA','qCF','FAC-2026-0911','DRAFT','DEPOSIT','2026-02-05',300.00,60.00,360.00,'admA',now(),'2026-02-05'),
       ('finCF','coA','wA','clA','qCF','FAC-2026-0912','DRAFT','INVOICE','2026-02-20',700.00,140.00,840.00,'admA',now(),'2026-02-20');
INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT",position,"deductsDepositId")
VALUES ('depCF-l','depCF','Acompte 30 %',1,300,20,300,0,NULL),
       ('finCF-l0','finCF','Travaux',1,1000,20,1000,0,NULL),
       ('finCF-l1','finCF','Acompte déduit FAC-2026-0911',1,-300,20,-300,1,'depCF');
UPDATE invoices SET status='SENT', "sentAt"='2026-02-05T10:00:00Z' WHERE id='depCF';
INSERT INTO invoice_deposit_deductions(id,"companyId","finalInvoiceId","depositInvoiceId","amountTTCCents","createdAt") VALUES ('dedCF','coA','finCF','depCF',36000,'2026-02-20T09:00:00Z');
UPDATE invoices SET status='SENT', "sentAt"='2026-02-20T10:00:00Z' WHERE id='finCF';
-- Avoir total (copie exacte, marqueur de déduction conservé) et annulation du solde — comme le service avant 064000 (sans libération).
INSERT INTO invoices(id,"companyId","worksiteId","clientId","quoteId",number,status,kind,"creditScope","creditedInvoiceId","issueDate","totalHT","totalVAT","totalTTC","createdById","updatedAt","createdAt")
VALUES ('cnCF','coA','wA','clA','qCF','AV-2026-0910','DRAFT','CREDIT_NOTE','TOTAL','finCF','2026-03-01',700.00,140.00,840.00,'admA',now(),'2026-03-01');
INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT",position,"deductsDepositId")
VALUES ('cnCF-l0','cnCF','Travaux',1,1000,20,1000,0,NULL),('cnCF-l1','cnCF','Acompte déduit FAC-2026-0911',1,-300,20,-300,1,'depCF');
UPDATE invoices SET status='CANCELLED', "updatedAt"='2026-03-01T11:00:00Z' WHERE id='finCF';
UPDATE invoices SET status='SENT', "sentAt"='2026-03-01T11:00:00Z' WHERE id='cnCF';
COMMIT;
