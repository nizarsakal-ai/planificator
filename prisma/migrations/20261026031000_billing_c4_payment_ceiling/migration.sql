-- Lot C4 — Le reste à payer d'une facture tient compte des avoirs partiels émis : Σ paiements ≤ TTC − Σ avoirs partiels,
-- PAID ⇔ paiements + avoirs partiels = TTC (ou Σ paiements = 0 : règlement constaté hors module, Lot B).
CREATE OR REPLACE FUNCTION invoice_payments_total_check() RETURNS trigger AS $$
DECLARE
  inv record; paid numeric; credited numeric; iid text;
BEGIN
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
  SELECT coalesce(sum("totalTTC"), 0) INTO credited FROM "invoices"
    WHERE "creditedInvoiceId" = inv."id" AND "kind"::text = 'CREDIT_NOTE' AND "creditScope"::text = 'PARTIAL' AND "status"::text <> 'CANCELLED';
  IF paid < 0 OR paid > inv."totalTTC" - credited THEN
    RAISE EXCEPTION 'PAYMENT_EXCEEDS_TOTAL: paiements (%) hors de [0, %] pour la facture % (avoirs partiels %).', paid, inv."totalTTC" - credited, inv."number", credited;
  END IF;
  IF (inv."status"::text = 'PAID' AND paid + credited <> inv."totalTTC" AND paid <> 0)
     OR (inv."status"::text = 'PARTIAL' AND NOT (paid > 0 AND paid + credited < inv."totalTTC"))
     OR (inv."status"::text = 'SENT' AND paid <> 0 AND inv."totalTTC" <> 0) THEN
    RAISE EXCEPTION 'PAYMENT_STATUS_MISMATCH: statut % incohérent avec paiements % et avoirs % (TTC %) pour la facture %.', inv."status", paid, credited, inv."totalTTC", inv."number";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
