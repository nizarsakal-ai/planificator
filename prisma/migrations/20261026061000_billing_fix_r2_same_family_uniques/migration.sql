-- Correctif Lot C — cycle R2 (revue Codex du 26/10/2026), défauts de MÊME FAMILLE que R2 (lecture puis décision sans verrou) :
-- deux invariants que le service contrôlait seulement par une lecture non verrouillée reçoivent un garde-fou en base.
-- Précontrôle : des données existantes qui violent déjà l'invariant arrêtent la migration avec un diagnostic explicite
-- (aucune réparation automatique, aucune suppression) — même règle que les migrations correctives 050000/051000.
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT "companyId", "quoteId" FROM "invoices" WHERE "quoteId" IS NOT NULL AND "kind"::text = 'INVOICE' AND "status"::text <> 'CANCELLED'
    GROUP BY "companyId", "quoteId" HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'BILLING_FIX_PRECHECK: % devis portent plusieurs factures de solde non annulées (invoices.quoteId, kind INVOICE) — à résoudre manuellement avant migration.', n;
  END IF;
  SELECT count(*) INTO n FROM (
    SELECT "companyId", "supplierId", "number" FROM "supplier_invoices" WHERE "supplierId" IS NOT NULL AND "status"::text = 'VALIDATED'
    GROUP BY "companyId", "supplierId", "number" HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'BILLING_FIX_PRECHECK: % numéros de facture fournisseur validés en double pour un même fournisseur — à résoudre manuellement avant migration.', n;
  END IF;
END $$;

-- A2 : une seule facture de solde (kind INVOICE) non annulée par devis et par société. Les acomptes (DEPOSIT) ne sont pas concernés ;
-- un brouillon abandonné (CANCELLED) libère le devis (règle convertQuoteCore).
CREATE UNIQUE INDEX "invoices_one_final_per_quote_key" ON "invoices"("companyId", "quoteId") WHERE "quoteId" IS NOT NULL AND "kind" = 'INVOICE' AND "status" <> 'CANCELLED';

-- A4 : une seule facture fournisseur VALIDÉE par (société, fournisseur, numéro) — deux validations concurrentes du même document ne
-- peuvent plus toutes deux comptabiliser une charge et une TVA déductible.
CREATE UNIQUE INDEX "supplier_invoices_one_validated_per_number_key" ON "supplier_invoices"("companyId", "supplierId", "number") WHERE "supplierId" IS NOT NULL AND "status" = 'VALIDATED';
