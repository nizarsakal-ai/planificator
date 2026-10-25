-- Lot C4 — Avoirs partiels (SPEC-BILLING-C4). Migration additive : portée de l'avoir (TOTAL = Lot B, PARTIAL), motif,
-- index unique partiel « un seul avoir TOTAL par facture » (plusieurs avoirs PARTIAL), rétro-remplissage des avoirs
-- existants en TOTAL, invariant Lot B limité aux avoirs totaux, contrôle différé du plafond des avoirs partiels.

-- CreateEnum
CREATE TYPE "InvoiceCreditScope" AS ENUM ('TOTAL', 'PARTIAL');

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "creditReason" TEXT,
ADD COLUMN     "creditScope" "InvoiceCreditScope";

-- Rétro-remplissage : tous les avoirs existants (Lot B) sont des avoirs totaux.
UPDATE "invoices" SET "creditScope" = 'TOTAL' WHERE "kind"::text = 'CREDIT_NOTE' AND "creditScope" IS NULL;

-- Compatibilité Lot B : un avoir créé sans portée (chemin Lot B, SQL direct) est un avoir TOTAL.
CREATE OR REPLACE FUNCTION invoices_credit_scope_default() RETURNS trigger AS $$
BEGIN
  IF NEW."kind"::text = 'CREDIT_NOTE' AND NEW."creditScope" IS NULL THEN NEW."creditScope" := 'TOTAL'; END IF;
  IF NEW."kind"::text <> 'CREDIT_NOTE' THEN NEW."creditScope" := NULL; NEW."creditReason" := NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoices_credit_scope_default_trg BEFORE INSERT ON "invoices" FOR EACH ROW EXECUTE FUNCTION invoices_credit_scope_default();

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credit_scope_ck"
  CHECK (("kind"::text <> 'CREDIT_NOTE' AND "creditScope" IS NULL) OR ("kind"::text = 'CREDIT_NOTE' AND "creditScope" IS NOT NULL));

-- Index : un seul avoir TOTAL par facture (même nom qu'au Lot B, désormais partiel) ; plusieurs avoirs partiels.
DROP INDEX "invoices_creditedInvoiceId_key";
CREATE UNIQUE INDEX "invoices_creditedInvoiceId_key" ON "invoices"("creditedInvoiceId") WHERE "creditScope" = 'TOTAL';
CREATE INDEX "invoices_creditedInvoiceId_idx" ON "invoices"("creditedInvoiceId");

-- La portée et le motif sont figés dès l'émission (ajoutés à la liste des champs immuables du déclencheur Lot B/C2).
CREATE OR REPLACE FUNCTION invoices_credit_scope_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."status"::text <> 'DRAFT' AND (NEW."creditScope" IS DISTINCT FROM OLD."creditScope" OR NEW."creditReason" IS DISTINCT FROM OLD."creditReason") THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: portée ou motif d''un avoir émis non modifiables (%).', OLD."number";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoices_credit_scope_guard_trg BEFORE UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION invoices_credit_scope_guard();

-- Invariant Lot B (copie exacte + facture annulée) : uniquement pour les avoirs TOTAUX.
CREATE OR REPLACE FUNCTION invoices_credit_invariant() RETURNS trigger AS $$
DECLARE
  cur record;
  note_id text;
BEGIN
  SELECT * INTO cur FROM "invoices" WHERE "id" = NEW."id";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF cur."kind"::text = 'CREDIT_NOTE' AND cur."creditScope"::text = 'TOTAL' THEN
    IF NOT invoice_credit_matches(cur."id", cur."creditedInvoiceId") THEN
      RAISE EXCEPTION 'CREDIT_NOTE_INVALID: l''avoir % n''est pas la copie exacte émise de la facture annulée (société, chantier, client, montants, lignes).', cur."number";
    END IF;
    IF EXISTS (SELECT 1 FROM "invoices" p WHERE p."creditedInvoiceId" = cur."creditedInvoiceId" AND p."creditScope"::text = 'PARTIAL' AND p."status"::text <> 'CANCELLED') THEN
      RAISE EXCEPTION 'CREDIT_NOTE_INVALID: avoir total impossible, des avoirs partiels existent sur la facture (%).', cur."number";
    END IF;
  END IF;

  IF cur."kind"::text IN ('INVOICE', 'DEPOSIT') AND cur."status"::text = 'CANCELLED' AND cur."sentAt" IS NOT NULL THEN
    SELECT n."id" INTO note_id FROM "invoices" n WHERE n."creditedInvoiceId" = cur."id" AND n."kind"::text = 'CREDIT_NOTE' AND n."creditScope"::text = 'TOTAL';
    IF note_id IS NULL OR NOT invoice_credit_matches(note_id, cur."id") THEN
      RAISE EXCEPTION 'INVOICE_CANCEL_WITHOUT_CREDIT_NOTE: la facture émise % ne peut être annulée que par un avoir total émis, copie exacte.', cur."number";
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Lignes d'un avoir : le contrôle de copie exacte ne concerne que les avoirs totaux.
CREATE OR REPLACE FUNCTION invoice_lines_credit_invariant() RETURNS trigger AS $$
DECLARE
  inv record;
  lid text;
BEGIN
  lid := CASE WHEN TG_OP = 'DELETE' THEN OLD."invoiceId" ELSE NEW."invoiceId" END;
  SELECT "id", "kind", "creditedInvoiceId", "number", "creditScope" INTO inv FROM "invoices" WHERE "id" = lid;
  IF FOUND AND inv."kind"::text = 'CREDIT_NOTE' AND inv."creditScope"::text = 'TOTAL' AND NOT invoice_credit_matches(inv."id", inv."creditedInvoiceId") THEN
    RAISE EXCEPTION 'CREDIT_NOTE_INVALID: lignes de l''avoir % différentes de la facture d''origine.', inv."number";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- La copie exacte Lot B admet désormais une origine de kind DEPOSIT (acompte annulé par avoir total).
CREATE OR REPLACE FUNCTION invoice_credit_matches(note_id text, orig_id text) RETURNS boolean AS $$
  SELECT EXISTS (
           SELECT 1 FROM "invoices" n JOIN "invoices" o ON o."id" = orig_id
           WHERE n."id" = note_id
             AND n."kind"::text = 'CREDIT_NOTE' AND n."creditedInvoiceId" = o."id" AND n."status"::text = 'SENT'
             AND o."kind"::text IN ('INVOICE', 'DEPOSIT') AND o."status"::text = 'CANCELLED' AND o."sentAt" IS NOT NULL
             AND n."companyId" = o."companyId" AND n."worksiteId" = o."worksiteId" AND n."clientId" = o."clientId"
             AND n."totalHT" = o."totalHT" AND n."totalVAT" = o."totalVAT" AND n."totalTTC" = o."totalTTC"
             AND n."globalDiscountBp" = o."globalDiscountBp" AND n."vatReverseCharge" = o."vatReverseCharge")
     AND NOT EXISTS (
           (SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp"
              FROM "invoice_lines" WHERE "invoiceId" = note_id
            EXCEPT ALL
            SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp"
              FROM "invoice_lines" WHERE "invoiceId" = orig_id)
           UNION ALL
           (SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp"
              FROM "invoice_lines" WHERE "invoiceId" = orig_id
            EXCEPT ALL
            SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp"
              FROM "invoice_lines" WHERE "invoiceId" = note_id))
$$ LANGUAGE sql STABLE;

-- Contrôle différé (COMMIT) des avoirs PARTIELS : origine émise (SENT/PARTIAL/PAID) de même société/chantier/client,
-- aucun avoir TOTAL coexistant, Σ TTC des avoirs partiels émis ≤ TTC de l'origine, montants positifs.
CREATE OR REPLACE FUNCTION invoice_partial_credit_check() RETURNS trigger AS $$
DECLARE
  n record; o record; total numeric;
BEGIN
  SELECT * INTO n FROM "invoices" WHERE "id" = NEW."id";
  IF NOT FOUND OR n."kind"::text <> 'CREDIT_NOTE' OR n."creditScope"::text <> 'PARTIAL' THEN RETURN NULL; END IF;
  -- Verrou de la facture d'origine : deux avoirs partiels concurrents sont sérialisés au COMMIT.
  SELECT * INTO o FROM "invoices" WHERE "id" = n."creditedInvoiceId" FOR UPDATE;
  IF NOT FOUND OR o."companyId" <> n."companyId" OR o."worksiteId" <> n."worksiteId" OR o."clientId" <> n."clientId"
     OR o."kind"::text NOT IN ('INVOICE', 'DEPOSIT') OR o."status"::text NOT IN ('SENT', 'PARTIAL', 'PAID') THEN
    RAISE EXCEPTION 'PARTIAL_CREDIT_INVALID: l''avoir partiel % doit viser une facture émise de même société, chantier et client.', n."number";
  END IF;
  IF n."status"::text <> 'SENT' OR n."totalTTC" <= 0 OR n."totalHT" < 0 OR n."totalVAT" < 0 THEN
    RAISE EXCEPTION 'PARTIAL_CREDIT_INVALID: un avoir partiel est émis immédiatement avec des montants positifs (%).', n."number";
  END IF;
  IF EXISTS (SELECT 1 FROM "invoices" t WHERE t."creditedInvoiceId" = o."id" AND t."creditScope"::text = 'TOTAL') THEN
    RAISE EXCEPTION 'PARTIAL_CREDIT_INVALID: la facture % a déjà un avoir total.', o."number";
  END IF;
  SELECT coalesce(sum("totalTTC"), 0) INTO total FROM "invoices" WHERE "creditedInvoiceId" = o."id" AND "creditScope"::text = 'PARTIAL' AND "status"::text <> 'CANCELLED';
  IF total > o."totalTTC" THEN
    RAISE EXCEPTION 'PARTIAL_CREDIT_EXCEEDS: avoirs partiels (%) > TTC de la facture % (%).', total, o."number", o."totalTTC";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER invoice_partial_credit_check_trg AFTER INSERT OR UPDATE ON "invoices"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_partial_credit_check();
