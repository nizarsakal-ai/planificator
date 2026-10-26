-- Variante NON COHÉRENTE (précontrôle P2-02) : une facture de A référence un devis de B — possible avant le correctif (FK simple).
BEGIN;
INSERT INTO invoices(id,"companyId","worksiteId","clientId","quoteId",number,status,kind,"issueDate","totalHT","totalVAT","totalTTC","createdById","updatedAt")
VALUES ('iX','coA','wA','clA','qB1','FAC-2026-0099','DRAFT','INVOICE','2026-02-02',1,0,1,'admA',now());
COMMIT;
