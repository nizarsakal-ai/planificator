-- Correctif Lot C — S1 (revue Codex R2 du 26/10/2026) : cohérence liaison d'acompte ↔ lignes de déduction ↔ devis lié à l'ÉMISSION.
-- Une facture de solde ne peut pas être émise (DRAFT → SENT) si elle porte une liaison invoice_deposit_deductions sans ligne de déduction
-- correspondante, une ligne de déduction sans liaison, une liaison vers un acompte non émis (brouillon, annulé par avoir), ou des liaisons
-- alors que son devis lié est NULL / différent de celui des acomptes
-- (le service refuse déjà : updateDraftInvoice interdit le retrait/changement de devis quand des déductions existent, depositIssueChecks
-- contrôle même sans devis ; la base impose l'invariant quel que soit le chemin, Lot B inclus). Contrainte DIFFÉRÉE (évaluée au COMMIT
-- ou par flushDeferredConstraints), comme les autres invariants de facturation.
-- Précontrôle : des factures de solde déjà émises incohérentes arrêtent la migration avec un diagnostic explicite (aucune réparation).
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM "invoices" f
   WHERE f."kind"::text = 'INVOICE' AND f."status"::text IN ('SENT', 'PARTIAL', 'PAID')
     AND (
       EXISTS (SELECT 1 FROM "invoice_deposit_deductions" d WHERE d."finalInvoiceId" = f."id"
                 AND (f."quoteId" IS NULL
                      OR NOT EXISTS (SELECT 1 FROM "invoice_lines" l WHERE l."invoiceId" = f."id" AND l."deductsDepositId" = d."depositInvoiceId")
                      OR NOT EXISTS (SELECT 1 FROM "invoices" dep WHERE dep."id" = d."depositInvoiceId" AND dep."quoteId" = f."quoteId" AND dep."status"::text IN ('SENT', 'PARTIAL', 'PAID'))))
       OR EXISTS (SELECT 1 FROM "invoice_lines" l WHERE l."invoiceId" = f."id" AND l."deductsDepositId" IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM "invoice_deposit_deductions" d WHERE d."finalInvoiceId" = f."id" AND d."depositInvoiceId" = l."deductsDepositId"))
     );
  IF n > 0 THEN
    RAISE EXCEPTION 'BILLING_FIX_PRECHECK: % facture(s) de solde émise(s) avec déductions d''acomptes incohérentes (liaison sans ligne, ligne sans liaison, devis absent ou différent) — à traiter manuellement avant cette migration.', n;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION invoice_deductions_consistency_check() RETURNS trigger AS $$
DECLARE bad INTEGER;
BEGIN
  IF NEW."kind"::text <> 'INVOICE' OR NEW."status"::text NOT IN ('SENT', 'PARTIAL', 'PAID') THEN
    RETURN NULL;
  END IF;
  -- Liaison sans ligne correspondante, devis absent ou acompte d'un autre devis.
  SELECT count(*) INTO bad FROM "invoice_deposit_deductions" d
   WHERE d."finalInvoiceId" = NEW."id"
     AND (NEW."quoteId" IS NULL
          OR NOT EXISTS (SELECT 1 FROM "invoice_lines" l WHERE l."invoiceId" = NEW."id" AND l."deductsDepositId" = d."depositInvoiceId")
          OR NOT EXISTS (SELECT 1 FROM "invoices" dep WHERE dep."id" = d."depositInvoiceId" AND dep."quoteId" = NEW."quoteId" AND dep."kind"::text = 'DEPOSIT'
                           AND dep."status"::text IN ('SENT', 'PARTIAL', 'PAID'))); -- un acompte annulé (avoir total) ne peut plus être déduit (audit R3, #3)
  IF bad > 0 THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: % liaison(s) d''acompte sans ligne de déduction, sans devis cohérent ou vers un acompte non émis sur la facture émise %.', bad, NEW."number";
  END IF;
  -- Ligne de déduction sans liaison.
  SELECT count(*) INTO bad FROM "invoice_lines" l
   WHERE l."invoiceId" = NEW."id" AND l."deductsDepositId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "invoice_deposit_deductions" d WHERE d."finalInvoiceId" = NEW."id" AND d."depositInvoiceId" = l."deductsDepositId");
  IF bad > 0 THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: % ligne(s) de déduction sans liaison d''acompte sur la facture émise %.', bad, NEW."number";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER invoice_deductions_consistency_check_trg AFTER UPDATE OF "status" ON "invoices"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."status"::text = 'DRAFT' AND NEW."status"::text <> 'DRAFT')
  EXECUTE FUNCTION invoice_deductions_consistency_check();
