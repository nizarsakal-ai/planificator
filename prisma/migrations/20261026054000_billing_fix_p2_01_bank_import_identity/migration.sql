-- Correctif Lot C — P2-01 (revue Codex du 26/10/2026) : identité d'une opération bancaire importée.
-- 1. externalId : identifiant bancaire stable fourni par le relevé (colonne choisie dans le mapping) ⇒ identité certaine, unique par société.
-- 2. Sans identifiant : empreinte (date, montant, libellé, référence) complétée par le rang d'OCCURRENCE du même tuple dans
--    le fichier (1, 2, 3…) : deux opérations réellement identiques d'un même relevé sont conservées ; le réimport du même
--    fichier n'ajoute rien ; des relevés qui se chevauchent ne perdent aucune occurrence (multiplicité = maximum observé).
--    L'empreinte de l'occurrence 1 garde le format antérieur : les lignes déjà importées restent valides sans recalcul.
-- 3. identityAmbiguous : une ligne dont l'identité repose sur une occurrence > 1 (ou dont le tuple est répété dans le fichier)
--    est conservée EN ATTENTE de résolution explicite : jamais de paiement créé automatiquement, rapprochement manuel seulement.
ALTER TABLE "bank_transactions" ADD COLUMN "externalId" TEXT,
  ADD COLUMN "occurrence" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "identityAmbiguous" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "bank_transactions_companyId_externalId_key" ON "bank_transactions"("companyId", "externalId");
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_occurrence_ck" CHECK ("occurrence" >= 1);
