-- Correctif Lot C — P1-01 et P1-07 (revue Codex du 26/10/2026).
-- P1-01 : la copie exacte d'un avoir TOTAL compare aussi le marqueur de déduction d'acompte (deductsDepositId) : une ligne de
--         déduction perdue ou altérée sur l'avoir est refusée au COMMIT (le recalcul de l'avoir divergerait de la pièce).
-- P1-07 : contrôle CENTRAL de l'origine, sous verrou, pour tout événement sur paiements ET avoirs (y compris l'insertion
--         d'un avoir partiel sans mise à jour de l'origine) : 0 ≤ paiements nets, paiements nets + avoirs partiels émis ≤ TTC,
--         statut cohérent ; PAID héritée sans ligne de paiement tolérée uniquement sans avoir partiel (jamais un contournement).
--         Avoir partiel sur un acompte (DEPOSIT) interdit en base ; TOTAL/PARTIAL mutuellement exclusifs (inchangé).

-- PRÉCONTRÔLE : un avoir TOTAL déjà émis dont les lignes diffèrent de l'origine sur le marqueur de déduction (créé par le chemin
-- antérieur à ce correctif) ne satisferait plus la copie exacte ; il est signalé AVANT la migration, sans réparation automatique.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "invoices" cn
   WHERE cn."kind"::text = 'CREDIT_NOTE' AND cn."creditScope"::text = 'TOTAL' AND cn."creditedInvoiceId" IS NOT NULL
     AND EXISTS (
       (SELECT "position", "deductsDepositId" FROM "invoice_lines" WHERE "invoiceId" = cn."id"
        EXCEPT ALL SELECT "position", "deductsDepositId" FROM "invoice_lines" WHERE "invoiceId" = cn."creditedInvoiceId")
       UNION ALL
       (SELECT "position", "deductsDepositId" FROM "invoice_lines" WHERE "invoiceId" = cn."creditedInvoiceId"
        EXCEPT ALL SELECT "position", "deductsDepositId" FROM "invoice_lines" WHERE "invoiceId" = cn."id"));
  IF n > 0 THEN
    RAISE EXCEPTION 'BILLING_FIX_PRECHECK: % avoir(s) total(aux) dont les lignes diffèrent de la facture d''origine sur le marqueur de déduction d''acompte (P1-01) : à traiter manuellement AVANT cette migration (aucune réparation automatique).', n;
  END IF;
END $$;

-- P1-01 — copie exacte avec le marqueur de déduction.
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
           (SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp", "deductsDepositId"
              FROM "invoice_lines" WHERE "invoiceId" = note_id
            EXCEPT ALL
            SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp", "deductsDepositId"
              FROM "invoice_lines" WHERE "invoiceId" = orig_id)
           UNION ALL
           (SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp", "deductsDepositId"
              FROM "invoice_lines" WHERE "invoiceId" = orig_id
            EXCEPT ALL
            SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp", "deductsDepositId"
              FROM "invoice_lines" WHERE "invoiceId" = note_id))
$$ LANGUAGE sql STABLE;

-- P1-07 — contrôle central du plafond et du statut de l'origine.
CREATE OR REPLACE FUNCTION invoice_payments_total_check() RETURNS trigger AS $$
DECLARE
  inv record; paid numeric; credited numeric; iid text; legacy boolean;
BEGIN
  -- Origine concernée : la facture du paiement, la facture créditée par l'avoir, ou la facture elle-même.
  IF TG_TABLE_NAME = 'invoice_payments' THEN
    iid := NEW."invoiceId";
  ELSIF NEW."kind"::text = 'CREDIT_NOTE' THEN
    iid := NEW."creditedInvoiceId";
  ELSE
    iid := NEW."id";
  END IF;
  IF iid IS NULL THEN RETURN NULL; END IF;
  -- Verrou de l'origine : paiements, contre-passations et avoirs concurrents sur une même facture sont sérialisés au COMMIT
  -- et la somme porte sur l'état final (aucun write skew). FOR NO KEY UPDATE : exclusif entre contrôleurs, mais compatible
  -- avec le verrou KEY SHARE que pose la FK d'un avoir/paiement inséré par une autre session (sinon attente croisée).
  SELECT "id", "number", "status", "kind", "totalTTC" INTO inv FROM "invoices" WHERE "id" = iid FOR NO KEY UPDATE;
  IF NOT FOUND OR inv."kind"::text NOT IN ('INVOICE', 'DEPOSIT') OR inv."status"::text NOT IN ('SENT', 'PARTIAL', 'PAID') THEN
    RETURN NULL;
  END IF;
  SELECT coalesce(sum("amountCents"), 0) / 100.0 INTO paid FROM "invoice_payments" WHERE "invoiceId" = inv."id";
  SELECT coalesce(sum("totalTTC"), 0) INTO credited FROM "invoices"
    WHERE "creditedInvoiceId" = inv."id" AND "kind"::text = 'CREDIT_NOTE' AND "creditScope"::text = 'PARTIAL' AND "status"::text <> 'CANCELLED';
  -- Règlement constaté hors module (Lot B : PAID sans ligne de paiement) : toléré seulement sans avoir partiel.
  legacy := inv."status"::text = 'PAID' AND paid = 0 AND credited = 0 AND inv."totalTTC" <> 0;
  IF paid < 0 THEN
    RAISE EXCEPTION 'PAYMENT_EXCEEDS_TOTAL: paiements nets négatifs (%) pour la facture %.', paid, inv."number";
  END IF;
  IF paid + credited > inv."totalTTC" THEN
    RAISE EXCEPTION 'PAYMENT_EXCEEDS_TOTAL: paiements (%) + avoirs partiels (%) > TTC (%) pour la facture %.', paid, credited, inv."totalTTC", inv."number";
  END IF;
  IF (inv."status"::text = 'PAID' AND NOT legacy AND paid + credited <> inv."totalTTC")
     OR (inv."status"::text = 'PARTIAL' AND NOT (paid > 0 AND paid + credited < inv."totalTTC"))
     OR (inv."status"::text = 'SENT' AND paid <> 0 AND inv."totalTTC" <> 0) THEN
    RAISE EXCEPTION 'PAYMENT_STATUS_MISMATCH: statut % incohérent avec paiements % et avoirs partiels % (TTC %) pour la facture %.', inv."status", paid, credited, inv."totalTTC", inv."number";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Le contrôle est désormais déclenché à l'INSERT comme à l'UPDATE d'une facture ou d'un avoir (origine résolue dans la fonction).
DROP TRIGGER IF EXISTS "invoices_payments_status_check_trg" ON "invoices";
CREATE CONSTRAINT TRIGGER invoices_payments_status_check_trg AFTER INSERT OR UPDATE ON "invoices"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_payments_total_check();

-- Avoir partiel : origine kind INVOICE uniquement (un acompte est déduit en totalité sur la facture de solde : avoir total seulement).
CREATE OR REPLACE FUNCTION invoice_partial_credit_check() RETURNS trigger AS $$
DECLARE
  n record; o record; total numeric;
BEGIN
  SELECT * INTO n FROM "invoices" WHERE "id" = NEW."id";
  IF NOT FOUND OR n."kind"::text <> 'CREDIT_NOTE' OR n."creditScope"::text <> 'PARTIAL' THEN RETURN NULL; END IF;
  SELECT * INTO o FROM "invoices" WHERE "id" = n."creditedInvoiceId" FOR NO KEY UPDATE; -- compatible KEY SHARE des FK, exclusif entre contrôleurs
  IF NOT FOUND OR o."companyId" <> n."companyId" OR o."worksiteId" <> n."worksiteId" OR o."clientId" <> n."clientId"
     OR o."status"::text NOT IN ('SENT', 'PARTIAL', 'PAID') THEN
    RAISE EXCEPTION 'PARTIAL_CREDIT_INVALID: l''avoir partiel % doit viser une facture émise de même société, chantier et client.', n."number";
  END IF;
  IF o."kind"::text <> 'INVOICE' THEN
    RAISE EXCEPTION 'PARTIAL_CREDIT_INVALID: un acompte (%) ne reçoit pas d''avoir partiel : avoir total uniquement.', o."number";
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
