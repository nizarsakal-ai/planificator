-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_companyId_fkey";

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_worksiteId_fkey";

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "creditedInvoiceId" TEXT,
ADD COLUMN     "kind" "InvoiceKind" NOT NULL DEFAULT 'INVOICE';

-- CreateIndex
CREATE UNIQUE INDEX "invoices_creditedInvoiceId_key" ON "invoices"("creditedInvoiceId");

-- CreateIndex
CREATE INDEX "invoices_kind_idx" ON "invoices"("kind");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_worksiteId_fkey" FOREIGN KEY ("worksiteId") REFERENCES "worksites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_creditedInvoiceId_fkey" FOREIGN KEY ("creditedInvoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- Lot B minimal — garanties en base (v2, après revue Codex du 25/10/2026).
-- 1. Une facture naît DRAFT ; kind, id, createdAt immuables ; aucune suppression hors DRAFT.
-- 2. Hors DRAFT : seules les transitions SENT→PAID, SENT/PAID→CANCELLED ; contenu figé ;
--    sentAt posé à l'émission, paidAt posé uniquement au passage à PAID.
-- 3. Lignes : toute mutation verrouille le(s) parent(s) (FOR SHARE, ordre déterministe) puis
--    refuse si un parent n'est pas DRAFT — sérialisé avec l'émission.
-- 4. Invariant différé (vérifié au COMMIT) : une facture émise annulée possède son avoir total
--    émis, de même société, mêmes montants ; un avoir référence une facture de même société.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_kind_credited_ck"
  CHECK (("kind" = 'INVOICE' AND "creditedInvoiceId" IS NULL)
      OR ("kind" = 'CREDIT_NOTE' AND "creditedInvoiceId" IS NOT NULL AND "creditedInvoiceId" <> "id"));

CREATE OR REPLACE FUNCTION invoices_guard_issued() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: une facture doit être créée en brouillon (%).', NEW."number";
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: une facture émise ne peut pas être supprimée (%).', OLD."number";
    END IF;
    RETURN OLD;
  END IF;

  -- Identité et nature : toujours immuables.
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
      IF NEW."kind" <> 'INVOICE' OR NEW."sentAt" IS NOT NULL OR NEW."paidAt" IS NOT NULL THEN
        RAISE EXCEPTION 'INVOICE_IMMUTABLE: abandon de brouillon invalide (%).', OLD."number";
      END IF;
      RETURN NEW;
    ELSE
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: transition DRAFT -> % interdite (%).', NEW."status", OLD."number";
    END IF;
  END IF;

  IF NOT (
       (OLD."status" = NEW."status")
    OR (OLD."status" = 'SENT' AND NEW."status" IN ('PAID', 'CANCELLED') AND OLD."kind" = 'INVOICE')
    OR (OLD."status" = 'PAID' AND NEW."status" = 'CANCELLED' AND OLD."kind" = 'INVOICE')
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
  THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: contenu d''une facture émise non modifiable (%).', OLD."number";
  END IF;

  -- paidAt : posé uniquement lors du passage SENT → PAID, jamais modifié ensuite.
  IF OLD."status" = 'SENT' AND NEW."status" = 'PAID' THEN
    IF OLD."paidAt" IS NOT NULL OR NEW."paidAt" IS NULL THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: date de paiement invalide (%).', OLD."number";
    END IF;
  ELSIF NEW."paidAt" IS DISTINCT FROM OLD."paidAt" THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: date de paiement non modifiable (%).', OLD."number";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoices_guard_issued_trg
  BEFORE INSERT OR UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION invoices_guard_issued();

-- Lignes : verrou partagé du parent (sérialisé avec l'UPDATE d'émission), puis contrôle du statut.
CREATE OR REPLACE FUNCTION invoice_lines_guard_issued() RETURNS trigger AS $$
DECLARE
  p_ids text[];
  bad   int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    p_ids := ARRAY[NEW."invoiceId"];
  ELSIF TG_OP = 'DELETE' THEN
    p_ids := ARRAY[OLD."invoiceId"];
  ELSE
    p_ids := ARRAY[OLD."invoiceId", NEW."invoiceId"];
  END IF;

  -- Ordre déterministe des verrous (évite les interblocages lors d'un déplacement de ligne).
  PERFORM 1 FROM "invoices" WHERE "id" = ANY(p_ids) ORDER BY "id" FOR SHARE;
  SELECT count(*) INTO bad FROM "invoices" WHERE "id" = ANY(p_ids) AND "status" <> 'DRAFT';
  IF bad > 0 THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: lignes d''une facture émise non modifiables.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_lines_guard_issued_trg
  BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard_issued();

-- Invariant différé : vérifié au COMMIT (autorise la séquence annulation → avoir → émission de createCreditNoteCore).
CREATE OR REPLACE FUNCTION invoices_credit_invariant() RETURNS trigger AS $$
DECLARE
  cur record;
  ok  boolean;
BEGIN
  SELECT * INTO cur FROM "invoices" WHERE "id" = NEW."id";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Avoir : référence une FACTURE de la même société, mêmes montants ; émis au COMMIT.
  IF cur."kind" = 'CREDIT_NOTE' THEN
    SELECT EXISTS (
      SELECT 1 FROM "invoices" o
      WHERE o."id" = cur."creditedInvoiceId" AND o."companyId" = cur."companyId" AND o."kind" = 'INVOICE'
        AND o."status" = 'CANCELLED' AND o."sentAt" IS NOT NULL
        AND o."totalHT" = cur."totalHT" AND o."totalVAT" = cur."totalVAT" AND o."totalTTC" = cur."totalTTC"
    ) INTO ok;
    IF NOT ok OR cur."status" <> 'SENT' THEN
      RAISE EXCEPTION 'CREDIT_NOTE_INVALID: avoir % incohérent (facture d''origine, société, montants ou émission).', cur."number";
    END IF;
  END IF;

  -- Facture émise annulée : son avoir total émis doit exister.
  IF cur."kind" = 'INVOICE' AND cur."status" = 'CANCELLED' AND cur."sentAt" IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM "invoices" n
      WHERE n."creditedInvoiceId" = cur."id" AND n."kind" = 'CREDIT_NOTE' AND n."companyId" = cur."companyId"
        AND n."status" = 'SENT'
        AND n."totalHT" = cur."totalHT" AND n."totalVAT" = cur."totalVAT" AND n."totalTTC" = cur."totalTTC"
    ) INTO ok;
    IF NOT ok THEN
      RAISE EXCEPTION 'INVOICE_CANCEL_WITHOUT_CREDIT_NOTE: la facture émise % ne peut être annulée que par un avoir total émis.', cur."number";
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER invoices_credit_invariant_trg
  AFTER INSERT OR UPDATE ON "invoices"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION invoices_credit_invariant();
