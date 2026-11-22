-- Planificator — application manuelle de la migration 20261127090000_v2_integration_routing_parity en production
-- (Neon SQL Editor, projet « planificator », branche « production », base « neondb », rôle neondb_owner).
-- Tout-ou-rien (BEGIN/COMMIT). Refuse de s'exécuter : hors de la base neondb, si la migration est déjà appliquée, ou si la
-- migration précédente de main manque. Corps identique au fichier de migration ; checksum = SHA-256 du fichier.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'neondb' THEN
    RAISE EXCEPTION 'Mauvaise base (%) : ce script ne vise que neondb (production).', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261127090000_v2_integration_routing_parity' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'Migration 20261127090000_v2_integration_routing_parity déjà appliquée : rien à faire.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM _prisma_migrations WHERE migration_name = '20261126090000_v2_integration_routing_decisions' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN
    RAISE EXCEPTION 'Migration préalable 20261126090000_v2_integration_routing_decisions absente.';
  END IF;
END $$;
UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name = '20261127090000_v2_integration_routing_parity' AND finished_at IS NULL AND rolled_back_at IS NULL;

-- 27/11/2026 — PLAN-INTEGRATION-PLATFORM-001 LOT-2D : observations de parité legacy L1 ↔ Router (SPEC LOT-2 §14, §16).
-- Plan d'implémentation LOT-2 validé par Nizar le 22/11/2026 (I5 : table en ajout seul, sans PII ; I6 : décision contre
-- décision). Migration ADDITIVE : une table neuve, aucune table existante modifiée, aucune donnée lue ni écrite.
-- Aucune valeur métier : l'identifiant externe n'est stocké que haché (SHA-256), jamais email, objet ni corps.
-- Garanties portées par la base : codes fermés, baseline unique, une observation par (message normalisé, configuration),
-- observation immuable (UPDATE refusé). À appliquer avec le rôle propriétaire, AVANT la fusion.


CREATE TABLE "integration_routing_parity_observations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "normalizedInboundId" TEXT,
    "externalIdHash" TEXT NOT NULL,
    "parityBaselineCode" TEXT NOT NULL DEFAULT 'L1_REGISTER_INCOMING_MESSAGE',
    "legacyOutcome" TEXT NOT NULL,
    "routerOutcome" TEXT,
    "routingDecisionId" TEXT,
    "routingConfigurationVersion" TEXT,
    "parityOutcome" TEXT NOT NULL,
    "explainedCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "comparisonCode" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_routing_parity_observations_pkey" PRIMARY KEY ("id")
);

-- Une observation par (message normalisé, configuration) : un rejeu du même message ne la duplique pas.
CREATE UNIQUE INDEX "integration_routing_parity_observations_key"
  ON "integration_routing_parity_observations"("companyId", "normalizedInboundId", "routingConfigurationVersion")
  WHERE "normalizedInboundId" IS NOT NULL AND "routingConfigurationVersion" IS NOT NULL;

CREATE INDEX "integration_routing_parity_observations_co_observedAt_idx"
  ON "integration_routing_parity_observations"("companyId", "observedAt");

ALTER TABLE "integration_routing_parity_observations"
  ADD CONSTRAINT "integration_routing_parity_observations_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_routing_parity_observations"
  ADD CONSTRAINT "integration_routing_parity_observations_normalized_fkey"
  FOREIGN KEY ("normalizedInboundId", "companyId")
  REFERENCES "integration_normalized_inbounds"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_routing_parity_observations"
  ADD CONSTRAINT "integration_routing_parity_observations_decision_fkey"
  FOREIGN KEY ("routingDecisionId", "companyId")
  REFERENCES "integration_routing_decisions"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_routing_parity_observations" ADD CONSTRAINT "integration_routing_parity_observations_values_check" CHECK (
  "externalIdHash" ~ '^[0-9a-f]{64}$'
  AND "parityBaselineCode" = 'L1_REGISTER_INCOMING_MESSAGE'
  AND "legacyOutcome" IN ('ADMIT', 'REJECT', 'UNKNOWN')
  AND ("routerOutcome" IS NULL OR "routerOutcome" IN ('MATCH', 'NO_MATCH', 'NO_ACTIVE_BINDING', 'AMBIGUOUS_SOURCE', 'ERROR'))
  AND "parityOutcome" IN ('PARITY_MATCH', 'PARITY_REJECT', 'PARITY_LEGACY_ONLY', 'PARITY_ROUTER_ONLY', 'PARITY_UNCOMPARABLE', 'PARITY_ERROR')
  AND "explainedCodes" <@ ARRAY['EXPLAINED_MATCH_NO_DRAFT', 'EXPLAINED_SUBJECT_ABSENT', 'EXPLAINED_BODY_UNAVAILABLE', 'EXPLAINED_QUALIFIER_GAP', 'EXPLAINED_CONFIG_NOT_SEEDED']::TEXT[]
  AND ("comparisonCode" IS NULL OR "comparisonCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
  AND ("routingConfigurationVersion" IS NULL OR "routingConfigurationVersion" ~ '^rcv1_[0-9a-f]{64}$')
  -- Une décision Router citée ⇔ son outcome, sa configuration et le message normalisé sont connus.
  AND (("routerOutcome" IS NULL) = ("routingDecisionId" IS NULL))
  AND ("routerOutcome" IS NULL OR ("routingConfigurationVersion" IS NOT NULL AND "normalizedInboundId" IS NOT NULL))
  -- Sans décision Router ou avec L1 indéterminée, la parité ne peut être qu'incomparable ou en erreur.
  AND (("routerOutcome" IS NOT NULL AND "legacyOutcome" <> 'UNKNOWN') OR "parityOutcome" IN ('PARITY_UNCOMPARABLE', 'PARITY_ERROR'))
);

CREATE FUNCTION integration_routing_parity_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'routing parity observation is immutable' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER integration_routing_parity_observations_immutable
  BEFORE UPDATE ON "integration_routing_parity_observations"
  FOR EACH ROW EXECUTE FUNCTION integration_routing_parity_immutable();

INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
VALUES (gen_random_uuid()::text, '967e9ef9786e4375bfb8b34e0857118a96f0b533cd9e33ac73aabd513c79c61f', now(), '20261127090000_v2_integration_routing_parity', NULL, NULL, now(), 1);
COMMIT;
