-- Correctif Lot C — P2-02 (revue Codex du 26/10/2026) : les liens des pièces comptables C5 (et le lien devis → facture C1,
-- la ligne de déduction C3) deviennent des FK COMPOSITES (companyId, id) : la base refuse tout lien inter-sociétés par DML direct.
-- Migration ADDITIVE : clés uniques (companyId, id), remplacement des FK simples, déclencheur de société sur les lignes de déduction.
-- PRÉCONTRÔLE : une donnée déjà incohérente arrête la migration avec un diagnostic explicite ; aucune réparation automatique.

DO $$
DECLARE n bigint; msg text := '';
BEGIN
  SELECT count(*) INTO n FROM "supplier_invoices" s JOIN "suppliers" p ON p."id" = s."supplierId" WHERE p."companyId" <> s."companyId";
  IF n > 0 THEN msg := msg || format('supplier_invoices.supplierId hors société : %s ; ', n); END IF;
  SELECT count(*) INTO n FROM "supplier_invoices" s JOIN "supplier_invoice_files" f ON f."id" = s."fileId" WHERE f."companyId" <> s."companyId";
  IF n > 0 THEN msg := msg || format('supplier_invoices.fileId hors société : %s ; ', n); END IF;
  SELECT count(*) INTO n FROM "bank_transactions" t JOIN "bank_statement_imports" i ON i."id" = t."importId" WHERE i."companyId" <> t."companyId";
  IF n > 0 THEN msg := msg || format('bank_transactions.importId hors société : %s ; ', n); END IF;
  SELECT count(*) INTO n FROM "bank_transactions" t JOIN "invoice_payments" p ON p."id" = t."matchedPaymentId" WHERE p."companyId" <> t."companyId";
  IF n > 0 THEN msg := msg || format('bank_transactions.matchedPaymentId hors société : %s ; ', n); END IF;
  SELECT count(*) INTO n FROM "bank_transactions" t JOIN "supplier_invoices" s ON s."id" = t."matchedSupplierInvoiceId" WHERE s."companyId" <> t."companyId";
  IF n > 0 THEN msg := msg || format('bank_transactions.matchedSupplierInvoiceId hors société : %s ; ', n); END IF;
  SELECT count(*) INTO n FROM "invoices" i JOIN "quotes" q ON q."id" = i."quoteId" WHERE q."companyId" <> i."companyId";
  IF n > 0 THEN msg := msg || format('invoices.quoteId hors société : %s ; ', n); END IF;
  SELECT count(*) INTO n FROM "invoice_lines" l JOIN "invoices" i ON i."id" = l."invoiceId" JOIN "invoices" d ON d."id" = l."deductsDepositId" WHERE d."companyId" <> i."companyId";
  IF n > 0 THEN msg := msg || format('invoice_lines.deductsDepositId hors société : %s ; ', n); END IF;
  IF msg <> '' THEN
    RAISE EXCEPTION 'BILLING_FIX_PRECHECK: liens inter-sociétés détectés, à corriger manuellement AVANT cette migration (aucune réparation automatique) : %', msg;
  END IF;
END $$;

-- Clés uniques (companyId, id) nécessaires aux FK composites.
CREATE UNIQUE INDEX "suppliers_companyId_id_key" ON "suppliers"("companyId", "id");
CREATE UNIQUE INDEX "supplier_invoice_files_companyId_id_key" ON "supplier_invoice_files"("companyId", "id");
CREATE UNIQUE INDEX "supplier_invoices_companyId_id_key" ON "supplier_invoices"("companyId", "id");
CREATE UNIQUE INDEX "bank_statement_imports_companyId_id_key" ON "bank_statement_imports"("companyId", "id");
CREATE UNIQUE INDEX "bank_transactions_companyId_id_key" ON "bank_transactions"("companyId", "id");
CREATE UNIQUE INDEX "invoice_payments_companyId_id_key" ON "invoice_payments"("companyId", "id");

-- supplier_invoices → suppliers / supplier_invoice_files
ALTER TABLE "supplier_invoices" DROP CONSTRAINT "supplier_invoices_supplierId_fkey";
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_companyId_supplierId_fkey" FOREIGN KEY ("companyId", "supplierId") REFERENCES "suppliers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "supplier_invoices" DROP CONSTRAINT "supplier_invoices_fileId_fkey";
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_companyId_fileId_fkey" FOREIGN KEY ("companyId", "fileId") REFERENCES "supplier_invoice_files"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- bank_transactions → import / paiement / facture fournisseur (le lien facture client était déjà composite).
ALTER TABLE "bank_transactions" DROP CONSTRAINT "bank_transactions_importId_fkey";
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_companyId_importId_fkey" FOREIGN KEY ("companyId", "importId") REFERENCES "bank_statement_imports"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_transactions" DROP CONSTRAINT "bank_transactions_matchedPaymentId_fkey";
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_companyId_matchedPaymentId_fkey" FOREIGN KEY ("companyId", "matchedPaymentId") REFERENCES "invoice_payments"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_transactions" DROP CONSTRAINT "bank_transactions_matchedSupplierInvoiceId_fkey";
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_companyId_matchedSupplierInvoiceId_fkey" FOREIGN KEY ("companyId", "matchedSupplierInvoiceId") REFERENCES "supplier_invoices"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- invoices → quotes (Lot C1) : même société imposée en base.
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_quoteId_fkey";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_companyId_quoteId_fkey" FOREIGN KEY ("companyId", "quoteId") REFERENCES "quotes"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- invoice_lines.deductsDepositId (Lot C3) : la table des lignes n'a pas de companyId ; la société de l'acompte déduit doit être
-- celle de la facture porteuse (déclencheur BEFORE, non différable : un lien incohérent est refusé immédiatement).
CREATE OR REPLACE FUNCTION invoice_lines_deduction_company_guard() RETURNS trigger AS $$
DECLARE inv_co text; dep_co text;
BEGIN
  IF NEW."deductsDepositId" IS NULL THEN RETURN NEW; END IF;
  SELECT "companyId" INTO inv_co FROM "invoices" WHERE "id" = NEW."invoiceId";
  SELECT "companyId" INTO dep_co FROM "invoices" WHERE "id" = NEW."deductsDepositId";
  IF inv_co IS NULL OR dep_co IS NULL OR inv_co <> dep_co THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: la ligne de déduction référence un acompte d''une autre société.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_lines_deduction_company_guard_trg BEFORE INSERT OR UPDATE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_deduction_company_guard();
