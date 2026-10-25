-- Lot C2 — Factures et paiements (SPEC-BILLING-C2). Migration ADDITIVE : nouvelles valeurs d'énumération,
-- colonnes facultatives, table invoice_payments, index ; déclencheurs Lot B remplacés en conservant toutes
-- leurs règles (les 39 essais SQL du Lot B restent verts).

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('TRANSFER', 'CHECK', 'CASH', 'CARD', 'DIRECT_DEBIT', 'OTHER');

-- AlterEnum
ALTER TYPE "InvoiceKind" ADD VALUE 'DEPOSIT';

-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'PARTIAL';

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "reminderDue30SentAt" TIMESTAMP(3),
ADD COLUMN     "reminderDue45SentAt" TIMESTAMP(3),
ADD COLUMN     "reminderDue60SentAt" TIMESTAMP(3),
ADD COLUMN     "subject" TEXT;

-- CreateTable
CREATE TABLE "invoice_payments" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paidAt" DATE NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "recordedById" TEXT NOT NULL,
    "reversesPaymentId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_payments_reversesPaymentId_key" ON "invoice_payments"("reversesPaymentId");

-- CreateIndex
CREATE INDEX "invoice_payments_invoiceId_idx" ON "invoice_payments"("invoiceId");

-- CreateIndex
CREATE INDEX "invoice_payments_companyId_paidAt_idx" ON "invoice_payments"("companyId", "paidAt");

-- CreateIndex
CREATE INDEX "invoices_companyId_status_idx" ON "invoices"("companyId", "status");

-- CreateIndex
CREATE INDEX "invoices_companyId_issueDate_idx" ON "invoices"("companyId", "issueDate");

-- CreateIndex
CREATE INDEX "invoices_companyId_dueDate_idx" ON "invoices"("companyId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_id_companyId_key" ON "invoices"("id", "companyId");

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_companyId_invoiceId_fkey" FOREIGN KEY ("companyId", "invoiceId") REFERENCES "invoices"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_reversesPaymentId_fkey" FOREIGN KEY ("reversesPaymentId") REFERENCES "invoice_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lot C2 : la contrainte Lot B « kind ↔ creditedInvoiceId » admet la nouvelle nature DEPOSIT (facture d'acompte, C3).
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_kind_credited_ck";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_kind_credited_ck"
  CHECK (("kind"::text IN ('INVOICE', 'DEPOSIT') AND "creditedInvoiceId" IS NULL)
      OR ("kind"::text = 'CREDIT_NOTE' AND "creditedInvoiceId" IS NOT NULL AND "creditedInvoiceId" <> "id"));

-- ═══════════════════════════════════════════════════════════════════════════
-- Lot C2 — Paiements et statuts (SPEC-BILLING-C2 §2). Toutes les règles du Lot B sont conservées.
-- Transitions ajoutées : SENT→PARTIAL, PARTIAL→PAID, PARTIAL→CANCELLED ; retours PARTIAL→SENT, PAID→PARTIAL,
-- PAID→SENT uniquement sous l'indicateur transactionnel « planificator.billing_payments » posé par le service de
-- paiement (contre-passation). L'indicateur n'est pas une frontière de privilège : il évite qu'un autre chemin
-- applicatif régresse un statut par erreur ; l'intégrité des sommes est garantie par le contrôle différé.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION billing_payments_context() RETURNS boolean AS $$
  SELECT coalesce(current_setting('planificator.billing_payments', true), '') = 'on'
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION invoices_guard_issued() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: une facture doit être créée en brouillon (%).', NEW."number";
    END IF;
    IF NEW."sentAt" IS NOT NULL OR NEW."paidAt" IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: un brouillon n''a ni date d''envoi ni de paiement (%).', NEW."number";
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::text <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: une facture émise ne peut pas être supprimée (%).', OLD."number";
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."companyId" IS DISTINCT FROM OLD."companyId" THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: identité, société ou nature non modifiables (%).', OLD."number";
  END IF;

  IF OLD."status"::text = 'DRAFT' THEN
    IF NEW."status"::text = 'DRAFT' THEN
      IF NEW."sentAt" IS NOT NULL OR NEW."paidAt" IS NOT NULL THEN
        RAISE EXCEPTION 'INVOICE_IMMUTABLE: un brouillon n''a ni date d''envoi ni de paiement (%).', OLD."number";
      END IF;
      RETURN NEW;
    ELSIF NEW."status"::text = 'SENT' THEN
      IF NEW."sentAt" IS NULL OR NEW."paidAt" IS NOT NULL THEN
        RAISE EXCEPTION 'INVOICE_IMMUTABLE: émission sans date d''envoi (%).', OLD."number";
      END IF;
      RETURN NEW;
    ELSIF NEW."status"::text = 'CANCELLED' THEN
      IF NEW."kind"::text <> 'INVOICE' OR NEW."sentAt" IS NOT NULL OR NEW."paidAt" IS NOT NULL THEN
        RAISE EXCEPTION 'INVOICE_IMMUTABLE: abandon de brouillon invalide (%).', OLD."number";
      END IF;
      RETURN NEW;
    ELSE
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: transition DRAFT -> % interdite (%).', NEW."status", OLD."number";
    END IF;
  END IF;

  -- Hors brouillon : transitions permises (Lot B + Lot C2).
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
  THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: contenu d''une facture émise non modifiable (%).', OLD."number";
  END IF;

  -- paidAt : posé en entrant dans PAID, effacé en le quittant (contre-passation), jamais modifié autrement.
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

-- Paiements : append-only, uniquement sur une facture émise (SENT/PARTIAL/PAID) de kind INVOICE/DEPOSIT.
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
  ELSIF NEW."amountCents" < 0 THEN
    RAISE EXCEPTION 'PAYMENT_INVALID: un montant négatif n''est permis que pour une contre-passation.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_payments_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON "invoice_payments"
  FOR EACH ROW EXECUTE FUNCTION invoice_payments_guard();

-- Contrôle différé (COMMIT) : 0 ≤ Σ paiements ≤ TTC et statut cohérent avec la somme, pour les factures émises INVOICE/DEPOSIT
-- (PAID ⇔ Σ = TTC, ou Σ = 0 pour un règlement constaté manuellement sans ligne de paiement — Lot B).
CREATE OR REPLACE FUNCTION invoice_payments_total_check() RETURNS trigger AS $$
DECLARE
  inv record; paid numeric; iid text;
BEGIN
  -- Déclencheur partagé par invoice_payments et invoices : la référence de champ est résolue par branche (plpgsql).
  IF TG_TABLE_NAME = 'invoice_payments' THEN
    iid := NEW."invoiceId";
  ELSE
    iid := NEW."id";
  END IF;
  SELECT "id", "number", "status", "kind", "totalTTC" INTO inv FROM "invoices" WHERE "id" = iid;
  IF NOT FOUND OR inv."kind"::text NOT IN ('INVOICE', 'DEPOSIT') OR inv."status"::text NOT IN ('SENT', 'PARTIAL', 'PAID') THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum("amountCents"), 0) / 100.0 INTO paid FROM "invoice_payments" WHERE "invoiceId" = inv."id";
  IF paid < 0 OR paid > inv."totalTTC" THEN
    RAISE EXCEPTION 'PAYMENT_EXCEEDS_TOTAL: paiements (%) hors de [0, %] pour la facture %.', paid, inv."totalTTC", inv."number";
  END IF;
  -- PAID sans paiement enregistré = règlement constaté manuellement (chemin Lot B, drapeau OFF) : toléré.
  IF (inv."status"::text = 'PAID' AND paid <> inv."totalTTC" AND paid <> 0)
     OR (inv."status"::text = 'PARTIAL' AND NOT (paid > 0 AND paid < inv."totalTTC"))
     OR (inv."status"::text = 'SENT' AND paid <> 0 AND inv."totalTTC" <> 0) THEN
    RAISE EXCEPTION 'PAYMENT_STATUS_MISMATCH: statut % incohérent avec les paiements (%/%) pour la facture %.', inv."status", paid, inv."totalTTC", inv."number";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER invoice_payments_total_check_trg AFTER INSERT OR UPDATE ON "invoice_payments"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_payments_total_check();
CREATE CONSTRAINT TRIGGER invoices_payments_status_check_trg AFTER UPDATE ON "invoices"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_payments_total_check();
