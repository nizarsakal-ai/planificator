-- V2 06/11/2026 — destinataire des devis et bon de commande client. Migration ADDITIVE : colonnes facultatives, contraintes
-- CHECK tolérantes à NULL, aucune réécriture de données. Les devis et factures existants gardent NULL (aucun changement rétroactif).
BEGIN;

-- Devis : destinataire effectif du dernier envoi/renvoi (distinct de clients.email) et bon de commande client.
ALTER TABLE "quotes" ADD COLUMN "recipientName" TEXT;
ALTER TABLE "quotes" ADD COLUMN "recipientEmail" TEXT;
ALTER TABLE "quotes" ADD COLUMN "recipientSource" TEXT;
ALTER TABLE "quotes" ADD COLUMN "clientPurchaseOrderRef" TEXT;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_recipient_name_len_check" CHECK ("recipientName" IS NULL OR char_length("recipientName") BETWEEN 1 AND 120);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_recipient_email_check" CHECK ("recipientEmail" IS NULL OR (char_length("recipientEmail") BETWEEN 3 AND 254 AND position('@' in "recipientEmail") > 1));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_recipient_source_check" CHECK ("recipientSource" IS NULL OR "recipientSource" IN ('CONSULTATION', 'PREVIOUS', 'CLIENT', 'MANUAL'));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_recipient_pair_check" CHECK ("recipientSource" IS NULL OR "recipientEmail" IS NOT NULL);
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_client_po_ref_len_check" CHECK ("clientPurchaseOrderRef" IS NULL OR char_length("clientPurchaseOrderRef") BETWEEN 1 AND 64);

-- Factures : bon de commande client (copié du devis à la conversion ; figé à l'émission par invoices_guard_issued ci-dessous).
ALTER TABLE "invoices" ADD COLUMN "clientPurchaseOrderRef" TEXT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_po_ref_len_check" CHECK ("clientPurchaseOrderRef" IS NULL OR char_length("clientPurchaseOrderRef") BETWEEN 1 AND 64);

-- Déclencheur d'immuabilité (définition Lot C3 reprise À L'IDENTIQUE) + une seule condition : clientPurchaseOrderRef figé hors brouillon.
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
     OR NEW."clientPurchaseOrderRef" IS DISTINCT FROM OLD."clientPurchaseOrderRef"
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

COMMIT;
