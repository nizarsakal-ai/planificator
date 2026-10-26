-- Correctif Lot C — S2, même famille (audit interne du cycle R3, #9) : le contrôle différé du plafond des acomptes
-- (invoice_deposits_ceiling_check, C3) verrouillait le DEVIS (FOR UPDATE) à chaque UPDATE d'une ligne d'acompte — paiement,
-- contre-passation, avoir total, abandon de brouillon, rapprochement bancaire — soit un verrou acompte → devis pris au COMMIT/flush,
-- ordre inverse de l'émission d'un solde (devis → facture → acomptes) : interblocage possible (40P01) sur des chemins sans rejeu.
-- Le plafond (Σ acomptes non annulés ≤ TTC du devis) ne peut augmenter qu'à l'INSERT ou par modification du montant, du devis lié ou de la
-- nature : le déclencheur est restreint à ces colonnes (fonction inchangée). Un changement de statut (paiement, annulation) ne le déclenche plus.
DROP TRIGGER IF EXISTS invoice_deposits_ceiling_check_trg ON "invoices";
CREATE CONSTRAINT TRIGGER invoice_deposits_ceiling_check_trg AFTER INSERT OR UPDATE OF "totalTTC", "quoteId", "kind", "companyId" ON "invoices"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_deposits_ceiling_check();

-- Revue interne R3 (#7) : la fonction ne modifie pas les clés du devis ; `FOR NO KEY UPDATE` (comme le contrôle du plafond des paiements,
-- P1-07) évite la montée de verrou NO KEY UPDATE → FOR UPDATE au flush, qui attendrait tout détenteur de KEY SHARE (pièce insérée référençant le devis).
CREATE OR REPLACE FUNCTION invoice_deposits_ceiling_check() RETURNS trigger AS $$
DECLARE
  q record; total numeric;
BEGIN
  IF NEW."kind"::text <> 'DEPOSIT' OR NEW."quoteId" IS NULL THEN RETURN NULL; END IF;
  SELECT "id", "number", "companyId", "totalTTC" INTO q FROM "quotes" WHERE "id" = NEW."quoteId" FOR NO KEY UPDATE;
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
