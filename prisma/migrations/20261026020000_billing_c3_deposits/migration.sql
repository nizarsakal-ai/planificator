-- Lot C3 — Acomptes (SPEC-BILLING-C3). Migration ADDITIVE : colonnes facultatives, table de liaison avec FK composites
-- (même société), déclencheurs de plafond et de cohérence des déductions.

-- AlterTable
ALTER TABLE "invoice_lines" ADD COLUMN     "deductsDepositId" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "depositBp" INTEGER;

-- CreateTable
CREATE TABLE "invoice_deposit_deductions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "finalInvoiceId" TEXT NOT NULL,
    "depositInvoiceId" TEXT NOT NULL,
    "amountTTCCents" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_deposit_deductions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_deposit_deductions_depositInvoiceId_key" ON "invoice_deposit_deductions"("depositInvoiceId");

-- CreateIndex
CREATE INDEX "invoice_deposit_deductions_finalInvoiceId_idx" ON "invoice_deposit_deductions"("finalInvoiceId");

-- CreateIndex
CREATE INDEX "invoice_lines_deductsDepositId_idx" ON "invoice_lines"("deductsDepositId");

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_deductsDepositId_fkey" FOREIGN KEY ("deductsDepositId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_deposit_deductions" ADD CONSTRAINT "invoice_deposit_deductions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_deposit_deductions" ADD CONSTRAINT "invoice_deposit_deductions_companyId_finalInvoiceId_fkey" FOREIGN KEY ("companyId", "finalInvoiceId") REFERENCES "invoices"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_deposit_deductions" ADD CONSTRAINT "invoice_deposit_deductions_companyId_depositInvoiceId_fkey" FOREIGN KEY ("companyId", "depositInvoiceId") REFERENCES "invoices"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Lot C3 — Acomptes (SPEC-BILLING-C3 §2) : plafond des acomptes par devis et cohérence des déductions, vérifiés
-- au COMMIT (défense en profondeur ; le service vérifie aussi sous verrou).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION invoice_deposits_ceiling_check() RETURNS trigger AS $$
DECLARE
  q record; total numeric;
BEGIN
  IF NEW."kind"::text <> 'DEPOSIT' OR NEW."quoteId" IS NULL THEN RETURN NULL; END IF;
  -- Verrou du devis : deux sessions insérant chacune un acompte sont sérialisées au COMMIT.
  SELECT "id", "number", "companyId", "totalTTC" INTO q FROM "quotes" WHERE "id" = NEW."quoteId" FOR UPDATE;
  IF NOT FOUND OR q."companyId" <> NEW."companyId" THEN
    RAISE EXCEPTION 'DEPOSIT_INVALID: devis introuvable pour cette société (acompte %).', NEW."number";
  END IF;
  SELECT coalesce(sum("totalTTC"), 0) INTO total FROM "invoices"
    WHERE "quoteId" = q."id" AND "kind"::text = 'DEPOSIT' AND "status"::text <> 'CANCELLED';
  IF total > q."totalTTC" THEN
    RAISE EXCEPTION 'DEPOSIT_EXCEEDS_QUOTE: acomptes (%) > TTC du devis % (%).', total, q."number", q."totalTTC";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER invoice_deposits_ceiling_check_trg AFTER INSERT OR UPDATE ON "invoices"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_deposits_ceiling_check();

-- Déduction : acompte émis (SENT/PARTIAL/PAID) de kind DEPOSIT, même société et même devis que la facture de solde (kind INVOICE).
CREATE OR REPLACE FUNCTION invoice_deposit_deductions_guard() RETURNS trigger AS $$
DECLARE
  f record; d record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_IMMUTABLE: une déduction se supprime et se recrée, jamais ne se modifie.';
  END IF;
  SELECT "id", "companyId", "kind", "quoteId", "status" INTO f FROM "invoices" WHERE "id" = NEW."finalInvoiceId";
  SELECT "id", "companyId", "kind", "quoteId", "status" INTO d FROM "invoices" WHERE "id" = NEW."depositInvoiceId";
  IF f IS NULL OR d IS NULL OR f."companyId" <> NEW."companyId" OR d."companyId" <> NEW."companyId" THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: factures introuvables pour cette société.';
  END IF;
  IF f."kind"::text <> 'INVOICE' OR d."kind"::text <> 'DEPOSIT' OR f."quoteId" IS NULL OR f."quoteId" IS DISTINCT FROM d."quoteId" THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: la déduction doit lier une facture de solde et un acompte du même devis.';
  END IF;
  IF d."status"::text NOT IN ('SENT', 'PARTIAL', 'PAID') THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: seul un acompte émis peut être déduit (%).', d."status";
  END IF;
  IF f."status"::text <> 'DRAFT' THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: les déductions ne se posent que sur une facture de solde en brouillon.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_deposit_deductions_guard_trg BEFORE INSERT OR UPDATE ON "invoice_deposit_deductions"
  FOR EACH ROW EXECUTE FUNCTION invoice_deposit_deductions_guard();

-- Une déduction d'une facture de solde ÉMISE ne se supprime plus (figée avec la facture).
CREATE OR REPLACE FUNCTION invoice_deposit_deductions_delete_guard() RETURNS trigger AS $$
DECLARE
  st text;
BEGIN
  SELECT "status"::text INTO st FROM "invoices" WHERE "id" = OLD."finalInvoiceId";
  -- Suppression permise tant que le solde est brouillon ou abandonné sans émission (reprise possible).
  IF st IS NOT NULL AND st <> 'DRAFT' AND NOT (st = 'CANCELLED' AND (SELECT "sentAt" FROM "invoices" WHERE "id" = OLD."finalInvoiceId") IS NULL) THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_IMMUTABLE: déduction figée avec la facture de solde émise.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_deposit_deductions_delete_guard_trg BEFORE DELETE ON "invoice_deposit_deductions"
  FOR EACH ROW EXECUTE FUNCTION invoice_deposit_deductions_delete_guard();

-- Lot C3 : un acompte en brouillon s'abandonne comme une facture (DRAFT → CANCELLED), mêmes règles qu'au Lot B/C2.
CREATE OR REPLACE FUNCTION invoices_guard_issued() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: une facture doit être créée en brouillon (%).', NEW."number";
    END IF;
    IF NEW."sentAt" IS NOT NULL OR NEW."paidAt" IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: un brouillon n''a ni date d''envoi ni de paiement (%).', NEW."number";
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: une facture émise ne peut pas être supprimée (%).', OLD."number";
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."companyId" IS DISTINCT FROM OLD."companyId" THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: identité, société ou nature non modifiables (%).', OLD."number";
  END IF;

  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" = 'DRAFT' THEN
      IF NEW."sentAt" IS NOT NULL OR NEW."paidAt" IS NOT NULL THEN
        RAISE EXCEPTION 'INVOICE_IMMUTABLE: un brouillon n''a ni date d''envoi ni de paiement (%).', OLD."number";
      END IF;
      RETURN NEW;
    ELSIF NEW."status" = 'SENT' THEN
      IF NEW."sentAt" IS NULL OR NEW."paidAt" IS NOT NULL THEN
        RAISE EXCEPTION 'INVOICE_IMMUTABLE: émission sans date d''envoi (%).', OLD."number";
      END IF;
      RETURN NEW;
    ELSIF NEW."status" = 'CANCELLED' THEN
      IF NEW."kind"::text NOT IN ('INVOICE', 'DEPOSIT') OR NEW."sentAt" IS NOT NULL OR NEW."paidAt" IS NOT NULL THEN
        RAISE EXCEPTION 'INVOICE_IMMUTABLE: abandon de brouillon invalide (%).', OLD."number";
      END IF;
      RETURN NEW;
    ELSE
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: transition DRAFT -> % interdite (%).', NEW."status", OLD."number";
    END IF;
  END IF;

  IF NOT (
       (OLD."status"::text = NEW."status"::text)
    OR (OLD."kind"::text IN ('INVOICE', 'DEPOSIT') AND (
           (OLD."status"::text = 'SENT' AND NEW."status"::text IN ('PAID', 'CANCELLED', 'PARTIAL'))
        OR (OLD."status"::text = 'PARTIAL' AND NEW."status"::text IN ('PAID', 'CANCELLED'))
        OR (OLD."status"::text = 'PAID' AND NEW."status"::text = 'CANCELLED')
        OR (billing_payments_context() AND (
               (OLD."status"::text = 'PARTIAL' AND NEW."status"::text = 'SENT')
            OR (OLD."status"::text = 'PAID' AND NEW."status"::text IN ('PARTIAL', 'SENT'))))))
  ) THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: transition % -> % interdite (%).', OLD."status", NEW."status", OLD."number";
  END IF;

  IF NEW."worksiteId" IS DISTINCT FROM OLD."worksiteId"
     OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
     OR NEW."quoteId" IS DISTINCT FROM OLD."quoteId"
     OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."creditedInvoiceId" IS DISTINCT FROM OLD."creditedInvoiceId"
     OR NEW."issueDate" IS DISTINCT FROM OLD."issueDate"
     OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate"
     OR NEW."periodStart" IS DISTINCT FROM OLD."periodStart"
     OR NEW."periodEnd" IS DISTINCT FROM OLD."periodEnd"
     OR NEW."totalHT" IS DISTINCT FROM OLD."totalHT"
     OR NEW."totalVAT" IS DISTINCT FROM OLD."totalVAT"
     OR NEW."totalTTC" IS DISTINCT FROM OLD."totalTTC"
     OR NEW."notes" IS DISTINCT FROM OLD."notes"
     OR NEW."paymentTerms" IS DISTINCT FROM OLD."paymentTerms"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."sentAt" IS DISTINCT FROM OLD."sentAt"
     OR NEW."globalDiscountBp" IS DISTINCT FROM OLD."globalDiscountBp"
     OR NEW."vatReverseCharge" IS DISTINCT FROM OLD."vatReverseCharge"
     OR NEW."subject" IS DISTINCT FROM OLD."subject"
     OR NEW."depositBp" IS DISTINCT FROM OLD."depositBp"
  THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: contenu d''une facture émise non modifiable (%).', OLD."number";
  END IF;

  IF OLD."status"::text <> 'PAID' AND NEW."status"::text = 'PAID' THEN
    IF OLD."paidAt" IS NOT NULL OR NEW."paidAt" IS NULL THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: date de paiement invalide (%).', OLD."number";
    END IF;
  ELSIF OLD."status"::text = 'PAID' AND NEW."status"::text IN ('PARTIAL', 'SENT') THEN
    IF NEW."paidAt" IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: date de paiement à effacer en quittant PAID (%).', OLD."number";
    END IF;
  ELSIF NEW."paidAt" IS DISTINCT FROM OLD."paidAt" THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: date de paiement non modifiable (%).', OLD."number";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
