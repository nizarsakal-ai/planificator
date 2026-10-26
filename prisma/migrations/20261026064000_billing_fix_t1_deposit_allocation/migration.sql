-- Correctif Lot C — T1 (revue Codex R3 du 26/10/2026) : affectation ACTIVE d'un acompte vs trace HISTORIQUE de déduction.
-- Après l'annulation intégrale (avoir total) d'une facture de solde émise, l'acompte déduit restait lié par une déduction immuable et
-- unique par acompte : reconversion du devis impossible (unicité), avoir sur l'acompte refusé. Arbitrage retenu (Nizar, sur
-- recommandation Codex) : la déduction d'une pièce émise n'est JAMAIS supprimée ni réécrite (trace historique avec le solde annulé et
-- son avoir) ; elle est LIBÉRÉE (releasedAt) à l'annulation du solde ; un acompte non annulé peut alors être affecté à
-- un nouveau solde du même devis (au plus UNE affectation active à la fois ; chaque cycle exige un avoir total tracé) (sans nouvel encaissement), ou recevoir un avoir si aucun autre solde actif ne le déduit.
-- Invariant : au plus UNE affectation active (releasedAt IS NULL) par acompte — index unique partiel (remplace l'unicité globale).
-- Précontrôle : des acomptes avec plusieurs affectations qui resteraient actives arrêtent la migration (aucune réparation).
ALTER TABLE "invoice_deposit_deductions" ADD COLUMN "releasedAt" TIMESTAMP(3);

-- Garde (REMPLACÉE AVANT la reprise : le déclencheur C3 `invoice_deposit_deductions_guard_trg` refusait tout UPDATE, la reprise ci-dessous
-- lèverait DEPOSIT_DEDUCTION_IMMUTABLE sur toute base contenant le cas T1) : une déduction ne se modifie jamais, SAUF sa libération
-- (releasedAt NULL → non NULL ; valeur = instant de décision du service, non bornée en base : une horloge de décision simulée ou un rejeu
-- antidaté restent légitimes) lorsque le solde est annulé après émission.
CREATE OR REPLACE FUNCTION invoice_deposit_deductions_guard() RETURNS trigger AS $$
DECLARE
  f record; d record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."releasedAt" IS NULL AND NEW."releasedAt" IS NOT NULL
       AND NEW."id" = OLD."id" AND NEW."companyId" = OLD."companyId" AND NEW."finalInvoiceId" = OLD."finalInvoiceId"
       AND NEW."depositInvoiceId" = OLD."depositInvoiceId" AND NEW."amountTTCCents" = OLD."amountTTCCents" AND NEW."createdAt" = OLD."createdAt" THEN
      SELECT "status"::text AS st, "sentAt" INTO f FROM "invoices" WHERE "id" = OLD."finalInvoiceId";
      IF f.st IS DISTINCT FROM 'CANCELLED' OR f."sentAt" IS NULL THEN
        RAISE EXCEPTION 'DEPOSIT_DEDUCTION_IMMUTABLE: une affectation ne se libère qu''à l''annulation d''un solde émis.';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_IMMUTABLE: une déduction se supprime et se recrée, jamais ne se modifie (hors libération).';
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
  IF NEW."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: une déduction se crée active (libération ultérieure uniquement).';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- Reprise : les déductions des soldes ÉMIS puis ANNULÉS sont libérées (datées de la dernière modification du solde, jamais avant leur
-- création) ; trace conservée. Jeu hérité : `run-legacy-campaign.sh cancelled-final`.
UPDATE "invoice_deposit_deductions" d SET "releasedAt" = greatest(coalesce(f."updatedAt", now()), d."createdAt")
  FROM "invoices" f WHERE f."id" = d."finalInvoiceId" AND f."status"::text = 'CANCELLED' AND f."sentAt" IS NOT NULL AND d."releasedAt" IS NULL;

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT "depositInvoiceId" FROM "invoice_deposit_deductions" WHERE "releasedAt" IS NULL GROUP BY "depositInvoiceId" HAVING count(*) > 1) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'BILLING_FIX_PRECHECK: % acompte(s) avec plusieurs affectations actives (soldes non annulés) — à résoudre manuellement avant cette migration.', n;
  END IF;
  SELECT count(*) INTO n FROM "invoice_deposit_deductions" d JOIN "invoices" f ON f."id" = d."finalInvoiceId"
   WHERE d."releasedAt" IS NULL AND f."status"::text = 'CANCELLED';
  IF n > 0 THEN
    RAISE EXCEPTION 'BILLING_FIX_PRECHECK: % déduction(s) active(s) vers un solde annulé jamais émis — incohérence héritée à traiter manuellement.', n;
  END IF;
  SELECT count(*) INTO n FROM "invoice_deposit_deductions" d JOIN "invoices" dep ON dep."id" = d."depositInvoiceId"
   WHERE d."releasedAt" IS NULL AND dep."status"::text NOT IN ('SENT', 'PARTIAL', 'PAID');
  IF n > 0 THEN
    RAISE EXCEPTION 'BILLING_FIX_PRECHECK: % affectation(s) active(s) vers un acompte non émis ou annulé — incohérence héritée à traiter manuellement.', n;
  END IF;
END $$;

-- Unicité : une seule affectation ACTIVE par acompte (l'historique libéré peut compter plusieurs traces).
DROP INDEX IF EXISTS "invoice_deposit_deductions_depositInvoiceId_key";
CREATE UNIQUE INDEX "invoice_deposit_deductions_one_active_per_deposit_key" ON "invoice_deposit_deductions"("depositInvoiceId") WHERE "releasedAt" IS NULL;
CREATE INDEX "invoice_deposit_deductions_depositInvoiceId_idx" ON "invoice_deposit_deductions"("depositInvoiceId");

-- Cohérence différée : une affectation active ne peut pas pointer un solde annulé NI un acompte non émis/annulé (évaluée au COMMIT sur un
-- instantané frais : une reconversion concurrente d'un avoir sur l'acompte est rejetée même si le garde BEFORE INSERT a lu l'ancien
-- statut) ; une trace libérée pointe un solde annulé émis.
CREATE OR REPLACE FUNCTION invoice_deduction_release_check() RETURNS trigger AS $$
DECLARE f record; dep_st text;
BEGIN
  SELECT "status"::text AS st, "sentAt" INTO f FROM "invoices" WHERE "id" = NEW."finalInvoiceId";
  IF NEW."releasedAt" IS NULL AND f.st = 'CANCELLED' THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: affectation active vers un solde annulé (libération manquante).';
  END IF;
  IF NEW."releasedAt" IS NULL THEN
    SELECT "status"::text INTO dep_st FROM "invoices" WHERE "id" = NEW."depositInvoiceId";
    IF dep_st IS NULL OR dep_st NOT IN ('SENT', 'PARTIAL', 'PAID') THEN
      RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: affectation active vers un acompte non émis ou annulé (%).', coalesce(dep_st, '?');
    END IF;
  END IF;
  IF NEW."releasedAt" IS NOT NULL AND (f.st IS DISTINCT FROM 'CANCELLED' OR f."sentAt" IS NULL) THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: trace libérée vers un solde non annulé.';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER invoice_deduction_release_check_trg AFTER INSERT OR UPDATE ON "invoice_deposit_deductions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION invoice_deduction_release_check();

-- L'annulation d'un solde émis par avoir total doit libérer ses affectations dans la même transaction (le service le fait ; la base l'impose).
CREATE OR REPLACE FUNCTION invoice_cancel_releases_deductions_check() RETURNS trigger AS $$
DECLARE n INTEGER;
BEGIN
  IF NEW."kind"::text <> 'INVOICE' OR NEW."status"::text <> 'CANCELLED' OR NEW."sentAt" IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO n FROM "invoice_deposit_deductions" WHERE "finalInvoiceId" = NEW."id" AND "releasedAt" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: % affectation(s) d''acompte non libérée(s) à l''annulation du solde %.', n, NEW."number";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER invoice_cancel_releases_deductions_check_trg AFTER UPDATE OF "status" ON "invoices"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW."status"::text = 'CANCELLED' AND OLD."status"::text <> 'CANCELLED')
  EXECUTE FUNCTION invoice_cancel_releases_deductions_check();

-- Contrainte S1 (062000) : seules les affectations ACTIVES d'une facture émise sont contrôlées (les traces libérées appartiennent à l'histoire).
CREATE OR REPLACE FUNCTION invoice_deductions_consistency_check() RETURNS trigger AS $$
DECLARE bad INTEGER;
BEGIN
  IF NEW."kind"::text <> 'INVOICE' OR NEW."status"::text NOT IN ('SENT', 'PARTIAL', 'PAID') THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO bad FROM "invoice_deposit_deductions" d
   WHERE d."finalInvoiceId" = NEW."id" AND d."releasedAt" IS NULL
     AND (NEW."quoteId" IS NULL
          OR NOT EXISTS (SELECT 1 FROM "invoice_lines" l WHERE l."invoiceId" = NEW."id" AND l."deductsDepositId" = d."depositInvoiceId")
          OR NOT EXISTS (SELECT 1 FROM "invoices" dep WHERE dep."id" = d."depositInvoiceId" AND dep."quoteId" = NEW."quoteId" AND dep."kind"::text = 'DEPOSIT'
                           AND dep."status"::text IN ('SENT', 'PARTIAL', 'PAID')));
  IF bad > 0 THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: % liaison(s) d''acompte sans ligne de déduction, sans devis cohérent ou vers un acompte non émis sur la facture émise %.', bad, NEW."number";
  END IF;
  SELECT count(*) INTO bad FROM "invoice_lines" l
   WHERE l."invoiceId" = NEW."id" AND l."deductsDepositId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "invoice_deposit_deductions" d WHERE d."finalInvoiceId" = NEW."id" AND d."depositInvoiceId" = l."deductsDepositId" AND d."releasedAt" IS NULL);
  IF bad > 0 THEN
    RAISE EXCEPTION 'DEPOSIT_DEDUCTION_INVALID: % ligne(s) de déduction sans liaison d''acompte sur la facture émise %.', bad, NEW."number";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
