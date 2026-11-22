-- 26/11/2026 — PLAN-INTEGRATION-PLATFORM-001 LOT-2C : décisions du Tenant Router (SPEC LOT-2 §9, §15, §19).
-- Plan d'implémentation LOT-2 validé par Nizar le 22/11/2026 (I2, I9). Migration ADDITIVE : une table neuve, aucune
-- table existante modifiée, aucune donnée lue ni écrite. Décisions shadow : aucune admission, aucune Envelope touchée.
-- Garanties portées par la base :
--  - idempotence (companyId, normalizedInboundId, routingConfigurationVersion) : une seule décision par clé ;
--  - `DUPLICATE` jamais persisté ; cohérence outcome ↔ Sources / pipelines ;
--  - décision immuable (UPDATE refusé) ; suppression seulement par cascade (société, NormalizedInbound) ou purge.
-- À appliquer avec le rôle propriétaire, AVANT la fusion (garde de schéma du build de production).

BEGIN;

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

COMMIT;
