-- Retour arrière des migrations Lot B (facturation), A1 (comptabilité) et FK figées — À EXÉCUTER SEULEMENT
-- avec une sauvegarde vérifiée et après avoir redéployé l'ancien code (le nouveau code exige ces colonnes).
-- Exécution : psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f ROLLBACK-ACCOUNTING-A1-BILLING-B.sql
-- (transaction unique : tout ou rien). Refuse si des données métier seraient perdues.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "journal_entries") THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: des écritures comptables existent ; export et décision requis avant retour arrière.';
  END IF;
  IF EXISTS (SELECT 1 FROM "invoices" WHERE "kind" = 'CREDIT_NOTE') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: des avoirs existent ; leur nature serait perdue (ils redeviendraient des factures).';
  END IF;
END $$;

-- 1. 20261025210000_billing_restrict_frozen_fks
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_quoteId_fkey";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoice_lines" DROP CONSTRAINT "invoice_lines_articleId_fkey";
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "articles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. 20261025200000_accounting_a1_engine (tables vides, vérifié ci-dessus)
DROP FUNCTION IF EXISTS accounting_post_entry(text, text, text);
DROP FUNCTION IF EXISTS accounting_advance_fiscal_year(text, text, text, text);
DROP TABLE IF EXISTS "journal_entry_lines", "journal_entries", "accounting_chain_heads", "accounting_sequences",
  "fiscal_years", "accounting_journals", "accounting_accounts" CASCADE;
DROP FUNCTION IF EXISTS accounting_entry_hash("journal_entries"), accounting_entry_canonical("journal_entries");
DROP FUNCTION IF EXISTS accounting_json_text(text), accounting_engine_context(),
  fiscal_years_guard(), accounting_accounts_guard(), journal_entries_guard(), journal_entry_lines_guard(),
  accounting_sequences_guard(), accounting_chain_heads_guard(), journal_entries_validation_check(),
  accounting_sequences_check(), accounting_chain_heads_check();
DROP TYPE IF EXISTS "FiscalYearStatus", "JournalEntryStatus", "AccountingJournalKind";

-- 3. 20261025180000_billing_lot_b_minimal
DROP TRIGGER IF EXISTS invoice_lines_credit_invariant_trg ON "invoice_lines";
DROP TRIGGER IF EXISTS invoice_lines_guard_issued_trg ON "invoice_lines";
DROP TRIGGER IF EXISTS invoices_credit_invariant_trg ON "invoices";
DROP TRIGGER IF EXISTS invoices_guard_issued_trg ON "invoices";
DROP FUNCTION IF EXISTS invoice_lines_credit_invariant(), invoices_credit_invariant(), invoice_credit_matches(text, text),
  invoice_lines_guard_issued(), invoices_guard_issued();
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_kind_credited_ck";
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_creditedInvoiceId_fkey";
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_companyId_fkey";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_worksiteId_fkey";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_worksiteId_fkey" FOREIGN KEY ("worksiteId") REFERENCES "worksites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX IF EXISTS "invoices_creditedInvoiceId_key", "invoices_kind_idx";
ALTER TABLE "invoices" DROP COLUMN IF EXISTS "creditedInvoiceId", DROP COLUMN IF EXISTS "kind";
DROP TYPE IF EXISTS "InvoiceKind";

-- 4. Historique Prisma
DELETE FROM "_prisma_migrations" WHERE "migration_name" IN
  ('20261025210000_billing_restrict_frozen_fks', '20261025200000_accounting_a1_engine', '20261025180000_billing_lot_b_minimal');
