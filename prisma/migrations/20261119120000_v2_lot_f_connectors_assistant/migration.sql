-- Lot F Planificator V2 (04/11/2026) : centre de connecteurs commerciaux (désactivés ou simulés) et assistant à
-- validation humaine. Migration EXPAND, additive : 5 types et 5 tables nouveaux, leurs index et clés. Aucun objet
-- existant modifié (la plateforme d'intégration et la passerelle agent restent telles quelles), aucune ligne existante
-- lue ni écrite. Corps généré par `prisma migrate diff` (schéma lot E vers ce lot), puis CHECK et déclencheurs à la
-- main en fin de fichier. Modules désactivés par défaut (CONNECTOR_CENTER_ENABLED, ASSISTANT_ENABLED).
-- Garanties portées par la base : aucun mode de connexion réelle (l'énumération n'a que DISABLED et SIMULATION) ;
-- catalogue de connecteurs fermé ; aucune réception en zone de transit hors mode simulation ; seul le fournisseur
-- LOCAL_RULES peut créer une proposition ; une proposition naît en attente et n'est exécutée qu'une fois, avec la tâche
-- créée dans la même entreprise ; journaux append-only.

BEGIN;

-- CreateEnum
CREATE TYPE "ConnectorMode" AS ENUM ('DISABLED', 'SIMULATION');

-- CreateEnum
CREATE TYPE "ConnectorSyncStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "AssistantActionKind" AS ENUM ('CREATE_TASK');

-- CreateEnum
CREATE TYPE "AssistantProposalStatus" AS ENUM ('PENDING', 'EXECUTED', 'REJECTED', 'OBSOLETE');

-- CreateEnum
CREATE TYPE "AssistantLogEvent" AS ENUM ('GENERATED', 'EXECUTED', 'REJECTED', 'OBSOLETE');

-- CreateTable
CREATE TABLE "connector_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectorKey" TEXT NOT NULL,
    "mode" "ConnectorMode" NOT NULL DEFAULT 'DISABLED',
    "watermark" TEXT,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_sync_runs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "settingId" TEXT NOT NULL,
    "connectorKey" TEXT NOT NULL,
    "mode" "ConnectorMode" NOT NULL,
    "status" "ConnectorSyncStatus" NOT NULL,
    "triggeredById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "watermarkBefore" TEXT,
    "watermarkAfter" TEXT,
    "received" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,

    CONSTRAINT "connector_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_staged_records" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "connectorKey" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "firstRunId" TEXT NOT NULL,
    "lastRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_staged_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_proposals" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "action" "AssistantActionKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "sources" JSONB NOT NULL,
    "status" "AssistantProposalStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "resultEntityType" TEXT,
    "resultEntityId" TEXT,

    CONSTRAINT "assistant_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_action_logs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "event" "AssistantLogEvent" NOT NULL,
    "actorId" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_action_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connector_settings_companyId_id_key" ON "connector_settings"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_settings_companyId_connectorKey_key" ON "connector_settings"("companyId", "connectorKey");

-- CreateIndex
CREATE INDEX "connector_sync_runs_companyId_connectorKey_startedAt_idx" ON "connector_sync_runs"("companyId", "connectorKey", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "connector_sync_runs_companyId_id_key" ON "connector_sync_runs"("companyId", "id");

-- CreateIndex
CREATE INDEX "connector_staged_records_companyId_connectorKey_updatedAt_idx" ON "connector_staged_records"("companyId", "connectorKey", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "connector_staged_records_companyId_id_key" ON "connector_staged_records"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_staged_records_companyId_connectorKey_resource_ex_key" ON "connector_staged_records"("companyId", "connectorKey", "resource", "externalId");

-- CreateIndex
CREATE INDEX "assistant_proposals_companyId_status_createdAt_idx" ON "assistant_proposals"("companyId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_proposals_companyId_id_key" ON "assistant_proposals"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_proposals_companyId_sourceKey_key" ON "assistant_proposals"("companyId", "sourceKey");

-- CreateIndex
CREATE INDEX "assistant_action_logs_companyId_createdAt_idx" ON "assistant_action_logs"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "assistant_action_logs_proposalId_createdAt_idx" ON "assistant_action_logs"("proposalId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "assistant_action_logs_companyId_id_key" ON "assistant_action_logs"("companyId", "id");

-- AddForeignKey
ALTER TABLE "connector_settings" ADD CONSTRAINT "connector_settings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_companyId_settingId_fkey" FOREIGN KEY ("companyId", "settingId") REFERENCES "connector_settings"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_staged_records" ADD CONSTRAINT "connector_staged_records_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_proposals" ADD CONSTRAINT "assistant_proposals_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_action_logs" ADD CONSTRAINT "assistant_action_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_action_logs" ADD CONSTRAINT "assistant_action_logs_companyId_proposalId_fkey" FOREIGN KEY ("companyId", "proposalId") REFERENCES "assistant_proposals"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Défense en profondeur (ajouts manuels) ───────────────────────────────────────────────────────────────────────

ALTER TABLE "connector_settings" ADD CONSTRAINT "connector_settings_values_check" CHECK (
  "connectorKey" IN ('shopify', 'stripe', 'mailchimp', 'meta_ads', 'google_ads', 'slack', 'chatgpt', 'google_calendar', 'outlook', 'sharepoint')
  AND length(btrim("changedById")) > 0
  AND ("watermark" IS NULL OR length("watermark") <= 4000)
);

ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_values_check" CHECK (
  "mode" = 'SIMULATION'
  AND "connectorKey" IN ('shopify', 'stripe', 'mailchimp', 'meta_ads', 'google_ads', 'slack', 'chatgpt', 'google_calendar', 'outlook', 'sharepoint')
  AND length(btrim("triggeredById")) > 0
  AND "finishedAt" >= "startedAt"
  AND "received" >= 0 AND "created" >= 0 AND "updated" >= 0 AND "unchanged" >= 0
  AND "received" = "created" + "updated" + "unchanged"
  AND ("watermarkBefore" IS NULL OR length("watermarkBefore") <= 4000)
  AND ("watermarkAfter" IS NULL OR length("watermarkAfter") <= 4000)
  AND (
    ("status" = 'SUCCEEDED' AND "errorCode" IS NULL)
    -- Revue Codex du 05/11 : IS NOT NULL explicites (une comparaison sur NULL vaut NULL, que le CHECK admettrait).
    OR ("status" = 'FAILED' AND "errorCode" IS NOT NULL AND "errorCode" IN ('SOURCE_UNAVAILABLE', 'SOURCE_ITEM_INVALID', 'WATERMARK_INVALID', 'REAL_CONNECTION_DISABLED', 'INTERNAL_ERROR') AND "received" = 0
        AND "watermarkAfter" IS NOT DISTINCT FROM "watermarkBefore")
  )
);

ALTER TABLE "connector_staged_records" ADD CONSTRAINT "connector_staged_records_values_check" CHECK (
  "connectorKey" IN ('shopify', 'stripe', 'mailchimp', 'meta_ads', 'google_ads', 'slack', 'chatgpt', 'google_calendar', 'outlook', 'sharepoint')
  AND "resource" ~ '^[a-z_]{2,40}$'
  AND length("externalId") BETWEEN 1 AND 200
  AND "payloadHash" ~ '^[0-9a-f]{64}$'
  AND "version" >= 1
  AND jsonb_typeof("payload") = 'object'
  AND octet_length("payload"::text) <= 8192
);

ALTER TABLE "assistant_proposals" ADD CONSTRAINT "assistant_proposals_values_check" CHECK (
  "provider" = 'LOCAL_RULES'
  AND "rule" IN ('OPPORTUNITY_FOLLOW_UP_OVERDUE', 'RESERVE_OVERDUE', 'STOCK_BELOW_MINIMUM')
  AND length("sourceKey") BETWEEN 3 AND 300
  AND length(btrim("title")) BETWEEN 3 AND 200
  AND length(btrim("rationale")) BETWEEN 3 AND 1000
  AND jsonb_typeof("payload") = 'object'
  AND jsonb_typeof("sources") = 'array' AND jsonb_array_length("sources") BETWEEN 1 AND 10
  AND length(btrim("createdById")) > 0
  AND ("decisionNote" IS NULL OR length("decisionNote") <= 500)
  AND (
    ("status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "resultEntityType" IS NULL AND "resultEntityId" IS NULL)
    OR ("status" = 'EXECUTED' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "resultEntityType" IS NOT NULL AND "resultEntityType" = 'Task' AND "resultEntityId" IS NOT NULL)
    OR ("status" IN ('REJECTED', 'OBSOLETE') AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "resultEntityType" IS NULL AND "resultEntityId" IS NULL)
  )
);

ALTER TABLE "assistant_action_logs" ADD CONSTRAINT "assistant_action_logs_values_check" CHECK (
  length(btrim("actorId")) > 0
  AND length("detail") BETWEEN 1 AND 500
);

-- ── Déclencheurs (ajouts manuels) ────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION lot_f_history_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lot F history immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER connector_sync_runs_immutable BEFORE UPDATE OR DELETE ON "connector_sync_runs"
  FOR EACH ROW EXECUTE FUNCTION lot_f_history_immutable();
CREATE TRIGGER connector_sync_runs_no_truncate BEFORE TRUNCATE ON "connector_sync_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_f_history_immutable();
CREATE TRIGGER assistant_action_logs_immutable BEFORE UPDATE OR DELETE ON "assistant_action_logs"
  FOR EACH ROW EXECUTE FUNCTION lot_f_history_immutable();
CREATE TRIGGER assistant_action_logs_no_truncate BEFORE TRUNCATE ON "assistant_action_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_f_history_immutable();
CREATE TRIGGER connector_settings_no_truncate BEFORE TRUNCATE ON "connector_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_f_history_immutable();
CREATE TRIGGER connector_staged_records_no_truncate BEFORE TRUNCATE ON "connector_staged_records"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_f_history_immutable();
CREATE TRIGGER assistant_proposals_no_truncate BEFORE TRUNCATE ON "assistant_proposals"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_f_history_immutable();

-- Réglage de connecteur : jamais supprimé ; identité figée.
CREATE FUNCTION connector_setting_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'connector setting cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."connectorKey", NEW."createdAt") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."connectorKey", OLD."createdAt") THEN
    RAISE EXCEPTION 'connector setting identity immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_settings_guard BEFORE UPDATE OR DELETE ON "connector_settings"
  FOR EACH ROW EXECUTE FUNCTION connector_setting_guard();

-- Synchronisation réussie : seulement pour un connecteur en mode simulation au moment de l'écriture.
CREATE FUNCTION connector_sync_run_mode() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'SUCCEEDED' AND NOT EXISTS (
    SELECT 1 FROM "connector_settings" s
    WHERE s."id" = NEW."settingId" AND s."companyId" = NEW."companyId" AND s."connectorKey" = NEW."connectorKey" AND s."mode" = 'SIMULATION'
  ) THEN
    RAISE EXCEPTION 'connector is not in simulation mode' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_sync_runs_mode BEFORE INSERT ON "connector_sync_runs"
  FOR EACH ROW EXECUTE FUNCTION connector_sync_run_mode();

-- Zone de transit : réception seulement en mode simulation ; jamais supprimée ; identité figée ; toute modification
-- est une nouvelle version d'un contenu différent (version + 1, empreinte changée).
CREATE FUNCTION connector_staged_record_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staged record cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "connector_settings" s
    WHERE s."companyId" = NEW."companyId" AND s."connectorKey" = NEW."connectorKey" AND s."mode" = 'SIMULATION'
  ) THEN
    RAISE EXCEPTION 'connector is not in simulation mode' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."companyId", NEW."connectorKey", NEW."resource", NEW."externalId", NEW."firstRunId", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."connectorKey", OLD."resource", OLD."externalId", OLD."firstRunId", OLD."createdAt") THEN
      RAISE EXCEPTION 'staged record identity immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."version" <> OLD."version" + 1 OR NEW."payloadHash" = OLD."payloadHash" THEN
      RAISE EXCEPTION 'staged record update must be a new version of a changed payload' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."version" <> 1 OR NEW."lastRunId" <> NEW."firstRunId" THEN
    RAISE EXCEPTION 'staged record must start at version 1' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_staged_records_guard BEFORE INSERT OR UPDATE OR DELETE ON "connector_staged_records"
  FOR EACH ROW EXECUTE FUNCTION connector_staged_record_guard();

-- Proposition : naît en attente ; contenu figé ; une seule décision (exécutée, refusée, périmée) ; une proposition
-- exécutée désigne une tâche de la MÊME entreprise ; jamais supprimée.
CREATE FUNCTION assistant_proposal_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'assistant proposal cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION 'assistant proposal must start pending' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."companyId", NEW."sourceKey", NEW."rule", NEW."provider", NEW."title", NEW."rationale", NEW."action", NEW."payload", NEW."sources", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."sourceKey", OLD."rule", OLD."provider", OLD."title", OLD."rationale", OLD."action", OLD."payload", OLD."sources", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'assistant proposal content immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'assistant proposal already decided' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'EXECUTED' AND NOT EXISTS (
    SELECT 1 FROM "tasks" t WHERE t."id" = NEW."resultEntityId" AND t."companyId" = NEW."companyId"
  ) THEN
    RAISE EXCEPTION 'assistant proposal result must be a task of the same company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assistant_proposals_guard BEFORE INSERT OR UPDATE OR DELETE ON "assistant_proposals"
  FOR EACH ROW EXECUTE FUNCTION assistant_proposal_guard();

COMMIT;
