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
-- Lot B minimal — immutabilité des factures émises, garantie en base.
-- Une facture non DRAFT ne peut changer que de statut vers l'avant
-- (SENT→PAID, SENT/PAID→CANCELLED par avoir) et recevoir paidAt ;
-- ses lignes ne peuvent plus être ajoutées, modifiées ni supprimées.
-- Aucune suppression d'une facture émise.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION invoices_guard_issued() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: une facture émise ne peut pas être supprimée (%).', OLD."number";
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF NOT (
       (OLD."status" = NEW."status")
    OR (OLD."status" = 'SENT' AND NEW."status" IN ('PAID', 'CANCELLED'))
    OR (OLD."status" = 'PAID' AND NEW."status" = 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: transition % -> % interdite (%).', OLD."status", NEW."status", OLD."number";
  END IF;

  IF NEW."companyId" IS DISTINCT FROM OLD."companyId"
     OR NEW."worksiteId" IS DISTINCT FROM OLD."worksiteId"
     OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
     OR NEW."quoteId" IS DISTINCT FROM OLD."quoteId"
     OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
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
     OR (OLD."paidAt" IS NOT NULL AND NEW."paidAt" IS DISTINCT FROM OLD."paidAt")
  THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: contenu d''une facture émise non modifiable (%).', OLD."number";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoices_guard_issued_trg
  BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION invoices_guard_issued();

CREATE OR REPLACE FUNCTION invoice_lines_guard_issued() RETURNS trigger AS $$
DECLARE
  parent_status "InvoiceStatus";
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "status" INTO parent_status FROM "invoices" WHERE "id" = OLD."invoiceId";
    IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: lignes d''une facture émise non modifiables.';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT "status" INTO parent_status FROM "invoices" WHERE "id" = NEW."invoiceId";
    IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVOICE_IMMUTABLE: lignes d''une facture émise non modifiables.';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_lines_guard_issued_trg
  BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_guard_issued();
