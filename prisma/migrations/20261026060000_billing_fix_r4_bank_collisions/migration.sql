-- Correctif Lot C — R4 (revue Codex R2 du 26/10/2026) : collisions d'identité bancaire ENTRE fichiers.
-- Sans identifiant bancaire stable, une opération dont le tuple (date, montant, libellé, référence) est déjà connu d'un relevé
-- antérieur peut être le même mouvement (relevés qui se chevauchent) OU un second mouvement réel identique : le logiciel ne sait
-- pas trancher. Elle n'est plus éliminée comme doublon certain : elle est CONSERVÉE (PENDING, identité ambiguë, occurrence
-- suivante) avec sa provenance (collisionOfId = opération déjà connue) jusqu'à une résolution explicite et tracée :
--   DUPLICATE ⇒ ignorée (IGNORED) ; DISTINCT ⇒ opération distincte, rapprochable. Aucun paiement n'est créé avant résolution.
-- tupleKey = empreinte du tuple SANS rang d'occurrence (recherche des collisions) ; NULL pour une opération à identifiant bancaire.
CREATE TYPE "BankCollisionResolution" AS ENUM ('DUPLICATE', 'DISTINCT');

ALTER TABLE "bank_transactions"
  ADD COLUMN "tupleKey" TEXT,
  ADD COLUMN "collisionOfId" TEXT,
  ADD COLUMN "collisionResolution" "BankCollisionResolution",
  ADD COLUMN "collisionResolvedAt" TIMESTAMP(3);

-- Provenance dans la même société (FK composite, correctif P2-02 appliqué à la nouvelle relation).
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_companyId_collisionOfId_fkey"
  FOREIGN KEY ("companyId", "collisionOfId") REFERENCES "bank_transactions"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "bank_transactions_companyId_tupleKey_idx" ON "bank_transactions"("companyId", "tupleKey");

-- Cohérence : une résolution suppose une collision ; une collision est datée quand elle est résolue ; jamais sa propre provenance.
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_collision_ck" CHECK (
  ("collisionResolution" IS NULL) = ("collisionResolvedAt" IS NULL)
  AND ("collisionResolution" IS NULL OR "collisionOfId" IS NOT NULL)
  AND ("collisionOfId" IS NULL OR "collisionOfId" <> "id")
);

-- Reprise des lignes existantes : l'empreinte de l'occurrence 1 EST l'empreinte du tuple (format antérieur conservé par P2-01).
UPDATE "bank_transactions" SET "tupleKey" = "fingerprint" WHERE "externalId" IS NULL AND "occurrence" = 1 AND "tupleKey" IS NULL;
-- Occurrences > 1 (créées par P2-01, jamais déployé hors bases jetables) : AUCUN recalcul SQL du hachage JavaScript (lower()/btrim ne reproduisent
-- pas toLowerCase()/trim() sur tout Unicode). Si de telles lignes existaient, la migration s'arrête avec un diagnostic explicite (même règle que 061000).
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM "bank_transactions" WHERE "externalId" IS NULL AND "occurrence" > 1 AND "tupleKey" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'BILLING_FIX_PRECHECK: % opérations bancaires d''occurrence > 1 sans tupleKey — reprise à définir manuellement (recalcul de l''empreinte du tuple côté application) avant cette migration.', n;
  END IF;
END $$;
