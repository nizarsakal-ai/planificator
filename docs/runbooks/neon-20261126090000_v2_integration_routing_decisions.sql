-- Planificator — application manuelle de la migration 20261126090000_v2_integration_routing_decisions en production
-- (Neon SQL Editor, projet « planificator », branche « production », base « neondb », rôle neondb_owner).
-- Tout-ou-rien (BEGIN/COMMIT). Refuse de s'exécuter : hors de la base neondb, si la migration est déjà appliquée, ou si la
-- migration précédente de main manque. Corps identique au fichier de migration ; checksum = SHA-256 du fichier.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Mauvaise base (%) : ce script ne vise que neondb (production).', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261126090000_v2_integration_routing_decisions' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'Migration 20261126090000_v2_integration_routing_decisions déjà appliquée : rien à faire.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261125090000_v2_integration_routing_config' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'Migration préalable 20261125090000_v2_integration_routing_config absente.';
  END IF;
END $$;
UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = '20261126090000_v2_integration_routing_decisions' AND finished_at IS NULL AND rolled_back_at IS NULL;

-- 26/11/2026 — PLAN-INTEGRATION-PLATFORM-001 LOT-2C : décisions du Tenant Router (SPEC LOT-2 §9, §15, §19).
-- Plan d'implémentation LOT-2 validé par Nizar le 22/11/2026 (I2, I9). Migration ADDITIVE : une table neuve, aucune
-- table existante modifiée, aucune donnée lue ni écrite. Décisions shadow : aucune admission, aucune Envelope touchée.
-- Garanties portées par la base :
--  - idempotence (companyId, normalizedInboundId, routingConfigurationVersion) : une seule décision par clé ;
--  - `DUPLICATE` jamais persisté ; cohérence outcome ↔ Sources / pipelines ;
--  - décision immuable (UPDATE refusé) ; suppression seulement par cascade (société, NormalizedInbound) ou purge.
-- À appliquer avec le rôle propriétaire, AVANT la fusion (garde de schéma du build de production).


CREATE TABLE "integration_routing_decisions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "normalizedInboundId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "matchedSourceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "pipelineIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "reasonCode" TEXT,
    "routingConfigurationVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_routing_decisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_routing_decisions_id_companyId_key"
  ON "integration_routing_decisions"("id", "companyId");

-- Idempotence niveau 4 (SPEC LOT-2 §9.2) : rejeu de la même clé ⇒ aucune nouvelle ligne.
CREATE UNIQUE INDEX "integration_routing_decisions_idempotency_key"
  ON "integration_routing_decisions"("companyId", "normalizedInboundId", "routingConfigurationVersion");

CREATE INDEX "integration_routing_decisions_companyId_decidedAt_idx"
  ON "integration_routing_decisions"("companyId", "decidedAt");

ALTER TABLE "integration_routing_decisions"
  ADD CONSTRAINT "integration_routing_decisions_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Même société que le NormalizedInbound (clé composite).
ALTER TABLE "integration_routing_decisions"
  ADD CONSTRAINT "integration_routing_decisions_normalized_fkey"
  FOREIGN KEY ("normalizedInboundId", "companyId")
  REFERENCES "integration_normalized_inbounds"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_routing_decisions" ADD CONSTRAINT "integration_routing_decisions_values_check" CHECK (
  "outcome" IN ('MATCH', 'NO_MATCH', 'NO_ACTIVE_BINDING', 'AMBIGUOUS_SOURCE', 'ERROR')
  AND "routingConfigurationVersion" ~ '^rcv1_[0-9a-f]{64}$'
  AND ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
  AND "schemaVersion" = '1.0.0'
  AND array_position("matchedSourceIds", NULL) IS NULL
  AND "pipelineIds" <@ ARRAY['consultations']::TEXT[]
  AND CASE "outcome"
    WHEN 'MATCH' THEN cardinality("matchedSourceIds") = 1 AND cardinality("pipelineIds") = 1
    WHEN 'NO_ACTIVE_BINDING' THEN cardinality("matchedSourceIds") = 1 AND cardinality("pipelineIds") = 0
    WHEN 'AMBIGUOUS_SOURCE' THEN cardinality("matchedSourceIds") >= 2 AND cardinality("pipelineIds") = 0
    ELSE cardinality("matchedSourceIds") = 0 AND cardinality("pipelineIds") = 0
  END
);

-- Une décision ne change jamais : un rejeu la relit, une nouvelle configuration en crée une autre.
CREATE FUNCTION integration_routing_decision_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'routing decision is immutable' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER integration_routing_decisions_immutable
  BEFORE UPDATE ON "integration_routing_decisions"
  FOR EACH ROW EXECUTE FUNCTION integration_routing_decision_immutable();

INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
VALUES (gen_random_uuid()::text, '46420459a2fcca58db09a3bcb7d9156c5643996800fa84079889f2f920f8c964', now(), '20261126090000_v2_integration_routing_decisions', NULL, NULL, now(), 1);
COMMIT;
