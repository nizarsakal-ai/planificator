-- Correctif Lot C — P1-03 et P1-04 (revue Codex du 26/10/2026) : rapprochement bancaire atomique et idempotent.
-- 1. Un paiement client porte l'identifiant de l'opération bancaire qui l'a créé (clé UNIQUE + FK composite société) :
--    jamais deux paiements pour une même opération, quelle que soit la reprise ou la concurrence.
-- 2. CHECK d'état : MATCHED ⇔ exactement une cible (facture client AVEC paiement lié, ou facture fournisseur) ;
--    PENDING/IGNORED ⇒ aucun lien. Plus aucun état « réservé sans paiement ».
-- 3. Une facture fournisseur n'est réglée qu'une fois (index unique partiel) et uniquement par un débit égal à son TTC.
-- 4. Contrôles différés au COMMIT (bank_match_check) : lien paiement ↔ opération réciproque et cohérent (société, facture,
--    montant) ; règlement fournisseur = société, VALIDATED, montant exact, paidAt posé.
-- PRÉCONTRÔLE : réservations orphelines ou doubles règlements existants ⇒ arrêt avec diagnostic, aucune réparation automatique.

DO $$
DECLARE n bigint; msg text := '';
BEGIN
  SELECT count(*) INTO n FROM "bank_transactions" WHERE "status"::text = 'MATCHED' AND "matchedInvoiceId" IS NOT NULL AND "matchedPaymentId" IS NULL;
  IF n > 0 THEN msg := msg || format('réservations MATCHED sans paiement rattaché (P1-03) : %s ; ', n); END IF;
  SELECT count(*) INTO n FROM "bank_transactions" WHERE ("status"::text = 'MATCHED' AND NOT (("matchedInvoiceId" IS NOT NULL AND "matchedPaymentId" IS NOT NULL AND "matchedSupplierInvoiceId" IS NULL) OR ("matchedInvoiceId" IS NULL AND "matchedPaymentId" IS NULL AND "matchedSupplierInvoiceId" IS NOT NULL)))
     OR ("status"::text <> 'MATCHED' AND ("matchedInvoiceId" IS NOT NULL OR "matchedPaymentId" IS NOT NULL OR "matchedSupplierInvoiceId" IS NOT NULL));
  IF n > 0 THEN msg := msg || format('opérations dans un état de rapprochement incohérent : %s ; ', n); END IF;
  SELECT count(*) INTO n FROM (SELECT "matchedSupplierInvoiceId" FROM "bank_transactions" WHERE "status"::text = 'MATCHED' AND "matchedSupplierInvoiceId" IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d;
  IF n > 0 THEN msg := msg || format('factures fournisseurs rapprochées plusieurs fois (P1-04) : %s ; ', n); END IF;
  SELECT count(*) INTO n FROM "bank_transactions" t JOIN "supplier_invoices" s ON s."id" = t."matchedSupplierInvoiceId" WHERE t."status"::text = 'MATCHED' AND -t."amountCents" <> s."totalTTCCents";
  IF n > 0 THEN msg := msg || format('règlements fournisseurs de montant différent du TTC (P1-04) : %s ; ', n); END IF;
  IF msg <> '' THEN
    RAISE EXCEPTION 'BILLING_FIX_PRECHECK: rapprochements bancaires incohérents, à traiter manuellement AVANT cette migration : %', msg;
  END IF;
END $$;

-- 1. Lien paiement → opération bancaire.
ALTER TABLE "invoice_payments" ADD COLUMN "bankTransactionId" TEXT;
CREATE UNIQUE INDEX "invoice_payments_bankTransactionId_key" ON "invoice_payments"("bankTransactionId");
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_companyId_bankTransactionId_fkey" FOREIGN KEY ("companyId", "bankTransactionId") REFERENCES "bank_transactions"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Reprise des liens existants (lien réciproque déjà porté par l'opération) : copie non destructive.
UPDATE "invoice_payments" p SET "bankTransactionId" = t."id" FROM "bank_transactions" t WHERE t."matchedPaymentId" = p."id" AND p."bankTransactionId" IS NULL;
-- Les événements différés créés par cette mise à jour sont évalués maintenant (sinon les DDL suivants sur invoice_payments échoueraient, SQLSTATE 55006).
SET CONSTRAINTS ALL IMMEDIATE;

-- 2. État d'une opération bancaire.
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_match_state_ck" CHECK (
  ("status"::text = 'MATCHED' AND (
       ("matchedInvoiceId" IS NOT NULL AND "matchedPaymentId" IS NOT NULL AND "matchedSupplierInvoiceId" IS NULL)
    OR ("matchedInvoiceId" IS NULL AND "matchedPaymentId" IS NULL AND "matchedSupplierInvoiceId" IS NOT NULL)))
  OR ("status"::text <> 'MATCHED' AND "matchedInvoiceId" IS NULL AND "matchedPaymentId" IS NULL AND "matchedSupplierInvoiceId" IS NULL)
);

-- 3. Une facture fournisseur n'est rapprochée (réglée) qu'une seule fois.
CREATE UNIQUE INDEX "bank_transactions_matchedSupplierInvoiceId_once_key" ON "bank_transactions"("matchedSupplierInvoiceId") WHERE "status" = 'MATCHED';

-- Le lien paiement → opération est figé comme les autres colonnes d'un paiement (append-only, Lot C2) ; une contre-passation ne porte jamais ce lien.
CREATE OR REPLACE FUNCTION invoice_payments_guard() RETURNS trigger AS $$
DECLARE
  inv record; orig record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PAYMENT_IMMUTABLE: un paiement ne se supprime pas (contre-passation uniquement).';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId"
       OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents" OR NEW."method" IS DISTINCT FROM OLD."method" OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt"
       OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."notes" IS DISTINCT FROM OLD."notes" OR NEW."recordedById" IS DISTINCT FROM OLD."recordedById"
       OR NEW."reversesPaymentId" IS DISTINCT FROM OLD."reversesPaymentId" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
       OR NEW."bankTransactionId" IS DISTINCT FROM OLD."bankTransactionId"
       OR (OLD."reversedAt" IS NOT NULL AND NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt") THEN
      RAISE EXCEPTION 'PAYMENT_IMMUTABLE: un paiement n''est pas modifiable (seule la pose de reversedAt est permise).';
    END IF;
    RETURN NEW;
  END IF;
  -- INSERT
  IF NEW."amountCents" = 0 THEN
    RAISE EXCEPTION 'PAYMENT_INVALID: montant nul.';
  END IF;
  SELECT "id", "companyId", "status", "kind" INTO inv FROM "invoices" WHERE "id" = NEW."invoiceId" FOR SHARE;
  IF NOT FOUND OR inv."companyId" <> NEW."companyId" THEN
    RAISE EXCEPTION 'PAYMENT_INVALID: facture introuvable pour cette société.';
  END IF;
  IF inv."kind"::text NOT IN ('INVOICE', 'DEPOSIT') OR inv."status"::text NOT IN ('SENT', 'PARTIAL', 'PAID') THEN
    RAISE EXCEPTION 'PAYMENT_INVALID: un paiement ne porte que sur une facture émise (statut %, nature %).', inv."status", inv."kind";
  END IF;
  IF NEW."reversesPaymentId" IS NOT NULL THEN
    SELECT * INTO orig FROM "invoice_payments" WHERE "id" = NEW."reversesPaymentId" FOR UPDATE;
    IF NOT FOUND OR orig."invoiceId" <> NEW."invoiceId" OR orig."companyId" <> NEW."companyId" OR orig."reversesPaymentId" IS NOT NULL
       OR orig."amountCents" <> -NEW."amountCents" THEN
      RAISE EXCEPTION 'PAYMENT_INVALID: contre-passation incohérente (même facture, montant opposé, paiement d''origine non contre-passé).';
    END IF;
    IF NEW."bankTransactionId" IS NOT NULL THEN
      RAISE EXCEPTION 'PAYMENT_INVALID: une contre-passation ne se lie pas à une opération bancaire.';
    END IF;
  ELSIF NEW."amountCents" < 0 THEN
    RAISE EXCEPTION 'PAYMENT_INVALID: un montant négatif n''est permis que pour une contre-passation.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Contrôle différé (COMMIT) du rapprochement.
CREATE OR REPLACE FUNCTION bank_match_check() RETURNS trigger AS $$
DECLARE
  t record; p record; s record; sid text;
BEGIN
  IF TG_TABLE_NAME = 'bank_transactions' THEN
    SELECT * INTO t FROM "bank_transactions" WHERE "id" = NEW."id";
    IF NOT FOUND OR t."status"::text <> 'MATCHED' THEN RETURN NULL; END IF;
    IF t."matchedPaymentId" IS NOT NULL THEN
      SELECT * INTO p FROM "invoice_payments" WHERE "id" = t."matchedPaymentId";
      IF NOT FOUND OR p."companyId" <> t."companyId" OR p."invoiceId" IS DISTINCT FROM t."matchedInvoiceId" OR p."amountCents" <> t."amountCents"
         OR p."bankTransactionId" IS DISTINCT FROM t."id" OR p."reversesPaymentId" IS NOT NULL OR t."amountCents" <= 0 THEN
        RAISE EXCEPTION 'BANK_MATCH_INVALID: opération % : paiement lié incohérent (société, facture, montant ou lien réciproque).', t."id";
      END IF;
    END IF;
    sid := t."matchedSupplierInvoiceId";
  ELSIF TG_TABLE_NAME = 'invoice_payments' THEN
    IF NEW."bankTransactionId" IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO t FROM "bank_transactions" WHERE "id" = NEW."bankTransactionId";
    IF NOT FOUND OR t."status"::text <> 'MATCHED' OR t."matchedPaymentId" IS DISTINCT FROM NEW."id" OR t."companyId" <> NEW."companyId" THEN
      RAISE EXCEPTION 'BANK_MATCH_INVALID: paiement % : opération bancaire liée incohérente (lien réciproque absent).', NEW."id";
    END IF;
    RETURN NULL;
  ELSE
    sid := NEW."id";
  END IF;
  IF sid IS NULL THEN RETURN NULL; END IF;
  SELECT "companyId", "status", "totalTTCCents", "paidAt" INTO s FROM "supplier_invoices" WHERE "id" = sid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO t FROM "bank_transactions" WHERE "matchedSupplierInvoiceId" = sid AND "status"::text = 'MATCHED';
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF t."companyId" <> s."companyId" OR t."amountCents" >= 0 OR -t."amountCents" <> s."totalTTCCents" OR s."status"::text <> 'VALIDATED' OR s."paidAt" IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_PAYMENT_INVALID: facture fournisseur % : règlement bancaire incohérent (société, sens, montant exact = TTC, statut VALIDATED, paidAt).', sid;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER bank_transactions_match_check_trg AFTER INSERT OR UPDATE ON "bank_transactions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_match_check();
CREATE CONSTRAINT TRIGGER invoice_payments_bank_link_check_trg AFTER INSERT OR UPDATE ON "invoice_payments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_match_check();
CREATE CONSTRAINT TRIGGER supplier_invoices_settlement_check_trg AFTER INSERT OR UPDATE ON "supplier_invoices"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_match_check();
