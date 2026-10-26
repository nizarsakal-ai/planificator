-- Variante NON COHÉRENTE (précontrôle P1-03), appliquée après C5 et avant les correctifs : réservation MATCHED sans paiement rattaché.
BEGIN;
INSERT INTO bank_statement_imports(id,"companyId","fileName",sha256,"rowCount",mapping,"importedById") VALUES ('impX','coA','ancien.csv','deadbeef',1,'{}','admA');
INSERT INTO bank_transactions(id,"companyId","importId",date,label,"amountCents",fingerprint,status,"matchedInvoiceId","matchedAt")
VALUES ('txX','coA','impX','2026-02-03','VIR ORPHELIN',36000,'fp-orphelin','MATCHED','iA5',now());
COMMIT;
