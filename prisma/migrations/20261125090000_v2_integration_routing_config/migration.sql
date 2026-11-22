-- 25/11/2026 — PLAN-INTEGRATION-PLATFORM-001 LOT-2B : configuration du routage (Sources, Rules, Bindings).
-- Plan d'implémentation LOT-2 validé par Nizar le 22/11/2026. Reprise de la migration de la PR #42
-- (20260801220000_add_integration_inbound_sources_rules), redatée après la dernière migration de main et complétée :
-- Bindings, bornes en base, invariant « Source active ⇒ au moins une rule IDENTITÉ active » vérifié en fin de transaction.
-- Migration ADDITIVE : aucune table existante modifiée, aucune donnée lue ni écrite. Aucun consommateur (Router en 2C).
-- À appliquer avec le rôle propriétaire, AVANT la fusion (garde de schéma du build de production).

BEGIN;

-- ── Enum ────────────────────────────────────────────────────────────────────

CREATE TYPE "InboundSourceRuleType" AS ENUM (
    'SENDER_EMAIL',
    'SENDER_DOMAIN',
    'SUBJECT_KEYWORD',
    'BODY_KEYWORD',
    'RECIPIENT_EMAIL'
);

-- ── InboundSource ───────────────────────────────────────────────────────────

CREATE TABLE "integration_inbound_sources" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "schemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_inbound_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_inbound_sources_id_companyId_key"
  ON "integration_inbound_sources"("id", "companyId");

CREATE INDEX "integration_inbound_sources_companyId_enabled_idx"
  ON "integration_inbound_sources"("companyId", "enabled");

ALTER TABLE "integration_inbound_sources"
  ADD CONSTRAINT "integration_inbound_sources_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── InboundSourceRule ───────────────────────────────────────────────────────

CREATE TABLE "integration_inbound_source_rules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "type" "InboundSourceRuleType" NOT NULL,
    "value" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "schemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_inbound_source_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_inbound_source_rules_id_companyId_key"
  ON "integration_inbound_source_rules"("id", "companyId");

CREATE UNIQUE INDEX "integration_inbound_source_rules_match_key"
  ON "integration_inbound_source_rules"("companyId", "sourceId", "type", "normalizedValue");

CREATE INDEX "integration_inbound_source_rules_co_type_norm_idx"
  ON "integration_inbound_source_rules"("companyId", "type", "normalizedValue");

CREATE INDEX "integration_inbound_source_rules_co_src_en_idx"
  ON "integration_inbound_source_rules"("companyId", "sourceId", "enabled");

ALTER TABLE "integration_inbound_source_rules"
  ADD CONSTRAINT "integration_inbound_source_rules_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_inbound_source_rules"
  ADD CONSTRAINT "integration_inbound_source_rules_source_fkey"
  FOREIGN KEY ("sourceId", "companyId")
  REFERENCES "integration_inbound_sources"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── PipelineBinding (LOT-2B) ────────────────────────────────────────────────
-- V1 : une Source active → au plus un Binding actif → pipeline « consultations ». Scope Connection optionnel (D13),
-- clé composite vers une Connection de la MÊME société (plan I10).

CREATE TABLE "integration_pipeline_bindings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL DEFAULT 'consultations',
    "connectionId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "schemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_pipeline_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_pipeline_bindings_id_companyId_key"
  ON "integration_pipeline_bindings"("id", "companyId");

CREATE INDEX "integration_pipeline_bindings_companyId_sourceId_idx"
  ON "integration_pipeline_bindings"("companyId", "sourceId");

-- Au plus un Binding actif par Source (SPEC §7.1).
CREATE UNIQUE INDEX "integration_pipeline_bindings_one_enabled_key"
  ON "integration_pipeline_bindings"("companyId", "sourceId") WHERE "enabled";

ALTER TABLE "integration_pipeline_bindings"
  ADD CONSTRAINT "integration_pipeline_bindings_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_pipeline_bindings"
  ADD CONSTRAINT "integration_pipeline_bindings_source_fkey"
  FOREIGN KEY ("sourceId", "companyId")
  REFERENCES "integration_inbound_sources"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "integration_pipeline_bindings"
  ADD CONSTRAINT "integration_pipeline_bindings_connection_fkey"
  FOREIGN KEY ("connectionId", "companyId")
  REFERENCES "integration_connections"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Bornes en base (SPEC §15.4 ; mêmes valeurs que INBOUND_SOURCE_BOUNDS) ───

ALTER TABLE "integration_inbound_sources" ADD CONSTRAINT "integration_inbound_sources_values_check" CHECK (
  char_length(btrim("displayName")) BETWEEN 1 AND 200
);

ALTER TABLE "integration_inbound_source_rules" ADD CONSTRAINT "integration_inbound_source_rules_values_check" CHECK (
  char_length("value") BETWEEN 1 AND 256
  AND char_length("normalizedValue") BETWEEN 1 AND 254
  AND ("type" NOT IN ('SUBJECT_KEYWORD', 'BODY_KEYWORD') OR char_length("normalizedValue") <= 128)
  AND "normalizedValue" = btrim("normalizedValue")
);

ALTER TABLE "integration_pipeline_bindings" ADD CONSTRAINT "integration_pipeline_bindings_values_check" CHECK (
  "pipelineId" = 'consultations'
);

-- ── Invariant IDENTITÉ (SPEC §5.3), vérifié en fin de transaction ───────────
-- Source active ⇒ au moins une rule SENDER_EMAIL ou SENDER_DOMAIN active. Contrôle différé : une transaction peut
-- activer la Source et ajouter sa rule dans n'importe quel ordre.

CREATE FUNCTION integration_inbound_source_identity_check() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  sid text;
  cid text;
BEGIN
  IF TG_TABLE_NAME = 'integration_inbound_sources' THEN
    sid := NEW."id"; cid := NEW."companyId";
  ELSIF TG_OP = 'DELETE' THEN
    sid := OLD."sourceId"; cid := OLD."companyId";
  ELSE
    sid := NEW."sourceId"; cid := NEW."companyId";
  END IF;
  IF EXISTS (SELECT 1 FROM "integration_inbound_sources" s WHERE s."id" = sid AND s."companyId" = cid AND s."enabled")
     AND NOT EXISTS (
       SELECT 1 FROM "integration_inbound_source_rules" r
       WHERE r."sourceId" = sid AND r."companyId" = cid AND r."enabled" AND r."type" IN ('SENDER_EMAIL', 'SENDER_DOMAIN')
     ) THEN
    RAISE EXCEPTION 'enabled inbound source requires an enabled identity rule' USING ERRCODE = '23514';
  END IF;
  -- Conditions imbriquées : PL/pgSQL évalue une expression d'un bloc, OLD."sourceId" n'existe pas côté Sources.
  IF TG_TABLE_NAME = 'integration_inbound_source_rules' THEN
    IF TG_OP = 'UPDATE' THEN
      IF (OLD."sourceId", OLD."companyId") IS DISTINCT FROM (NEW."sourceId", NEW."companyId") THEN
        RAISE EXCEPTION 'inbound source rule cannot move to another source' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER integration_inbound_sources_identity_check
  AFTER INSERT OR UPDATE ON "integration_inbound_sources"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION integration_inbound_source_identity_check();

CREATE CONSTRAINT TRIGGER integration_inbound_source_rules_identity_check
  AFTER INSERT OR UPDATE OR DELETE ON "integration_inbound_source_rules"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION integration_inbound_source_identity_check();

COMMIT;
