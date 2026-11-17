-- Lot E Planificator V2 : opportunités commerciales et automatisations bornées. Écrit le 04/11/2026 sur l'ancienne ligne,
-- reporté sur main 12debffa le 15/11/2026 (renumérotée après 20261113120000) ; déclencheur « réserve en retard » RETIRÉ
-- (dépend du lot D, absent de main). Corps repris du lot E à l'identique hors cette valeur et la clé d'idempotence
-- élargie à (société, règle, événement) le 15/11/2026 à la reprise ; vérification par
-- `prisma migrate diff` (main → main+E) à faire en VM isolée.
-- Migration EXPAND, additive : 6 types et 4 tables nouveaux, leurs index et clés ; une seule évolution d'un objet
-- existant : la VALEUR d'énumération 'AUTOMATION' ajoutée à "NotificationType" (ALTER TYPE … ADD VALUE, sans
-- réécriture de table ; la valeur n'est pas utilisée dans cette transaction, ce que PostgreSQL 12+ exige). Aucune
-- table existante modifiée, aucune ligne existante lue ni écrite. Corps généré à l'origine par `prisma migrate diff` (schéma lot D
-- vers ce lot), puis CHECK et déclencheurs à la main en fin de fichier. Modules désactivés par défaut
-- (CRM_OPPORTUNITIES_ENABLED, AUTOMATIONS_ENABLED).

BEGIN;

CREATE TYPE "OpportunityStage" AS ENUM ('LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST');

CREATE TYPE "OpportunityEventType" AS ENUM ('CREATED', 'STAGE_CHANGED', 'UPDATED', 'FOLLOW_UP_DONE', 'NOTE');

CREATE TYPE "AutomationTrigger" AS ENUM ('OPPORTUNITY_STAGE_CHANGED', 'OPPORTUNITY_FOLLOW_UP_DUE', 'QUOTE_ACCEPTED');

CREATE TYPE "AutomationAction" AS ENUM ('CREATE_TASK', 'NOTIFY_ADMINS');

CREATE TYPE "AutomationRuleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED');

CREATE TYPE "AutomationRunStatus" AS ENUM ('DONE', 'SKIPPED');

ALTER TYPE "NotificationType" ADD VALUE 'AUTOMATION';

CREATE TABLE "opportunities" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "clientId" TEXT,
    "prospectName" TEXT,
    "worksiteId" TEXT,
    "quoteId" TEXT,
    "consultationDraftId" TEXT,
    "stage" "OpportunityStage" NOT NULL DEFAULT 'LEAD',
    "probabilityBp" INTEGER NOT NULL,
    "amountCents" BIGINT NOT NULL DEFAULT 0,
    "expectedCloseDate" DATE,
    "ownerEmployeeId" TEXT,
    "nextFollowUpDate" DATE,
    "followUpNote" TEXT,
    "lostReason" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "opportunity_events" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "type" "OpportunityEventType" NOT NULL,
    "fromStage" "OpportunityStage",
    "toStage" "OpportunityStage",
    "note" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "opportunity_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "automation_rules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" "AutomationTrigger" NOT NULL,
    "stageFilter" "OpportunityStage",
    "action" "AutomationAction" NOT NULL,
    "taskTitle" TEXT,
    "taskAssigneeId" TEXT,
    "taskDueInDays" INTEGER,
    "message" TEXT,
    "status" "AutomationRuleStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "status" "AutomationRunStatus" NOT NULL,
    "detail" TEXT NOT NULL,
    "taskId" TEXT,
    "notified" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "opportunities_companyId_stage_idx" ON "opportunities"("companyId", "stage");

CREATE INDEX "opportunities_companyId_nextFollowUpDate_idx" ON "opportunities"("companyId", "nextFollowUpDate");

CREATE UNIQUE INDEX "opportunities_companyId_id_key" ON "opportunities"("companyId", "id");

CREATE UNIQUE INDEX "opportunities_companyId_number_key" ON "opportunities"("companyId", "number");

CREATE INDEX "opportunity_events_companyId_opportunityId_createdAt_idx" ON "opportunity_events"("companyId", "opportunityId", "createdAt");

CREATE INDEX "opportunity_events_companyId_type_createdAt_idx" ON "opportunity_events"("companyId", "type", "createdAt");

CREATE UNIQUE INDEX "opportunity_events_companyId_id_key" ON "opportunity_events"("companyId", "id");

CREATE INDEX "automation_rules_companyId_status_idx" ON "automation_rules"("companyId", "status");

CREATE UNIQUE INDEX "automation_rules_companyId_id_key" ON "automation_rules"("companyId", "id");

CREATE INDEX "automation_runs_companyId_createdAt_idx" ON "automation_runs"("companyId", "createdAt");

CREATE UNIQUE INDEX "automation_runs_companyId_id_key" ON "automation_runs"("companyId", "id");

CREATE UNIQUE INDEX "automation_runs_companyId_ruleId_eventKey_key" ON "automation_runs"("companyId", "ruleId", "eventKey");

ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_quoteId_companyId_fkey" FOREIGN KEY ("quoteId", "companyId") REFERENCES "quotes"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_ownerEmployeeId_companyId_fkey" FOREIGN KEY ("ownerEmployeeId", "companyId") REFERENCES "employees"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "opportunity_events" ADD CONSTRAINT "opportunity_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "opportunity_events" ADD CONSTRAINT "opportunity_events_companyId_opportunityId_fkey" FOREIGN KEY ("companyId", "opportunityId") REFERENCES "opportunities"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_taskAssigneeId_companyId_fkey" FOREIGN KEY ("taskAssigneeId", "companyId") REFERENCES "employees"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_companyId_ruleId_fkey" FOREIGN KEY ("companyId", "ruleId") REFERENCES "automation_rules"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Défense en profondeur (ajouts manuels) ───────────────────────────────────────────────────────────────────────

ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_values_check" CHECK (
  length(btrim("title")) BETWEEN 3 AND 200
  AND ("clientId" IS NOT NULL OR length(btrim(coalesce("prospectName", ''))) >= 2)
  AND ("prospectName" IS NULL OR length("prospectName") <= 200)
  AND "probabilityBp" BETWEEN 0 AND 10000
  AND "amountCents" BETWEEN 0 AND 10000000000000
  AND ("followUpNote" IS NULL OR length("followUpNote") <= 1000)
  AND ("lostReason" IS NULL OR length("lostReason") <= 500)
  AND length(btrim("createdById")) > 0
  AND (
    ("stage" IN ('LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION') AND "closedAt" IS NULL AND "lostReason" IS NULL)
    OR ("stage" = 'WON' AND "closedAt" IS NOT NULL AND "probabilityBp" = 10000 AND "lostReason" IS NULL)
    OR ("stage" = 'LOST' AND "closedAt" IS NOT NULL AND "probabilityBp" = 0 AND "lostReason" IS NOT NULL AND length(btrim("lostReason")) >= 3)
  )
);

ALTER TABLE "opportunity_events" ADD CONSTRAINT "opportunity_events_values_check" CHECK (
  ("note" IS NULL OR length("note") <= 2000)
  AND length(btrim("actorId")) > 0
  AND (("type" = 'STAGE_CHANGED') = ("fromStage" IS NOT NULL AND "toStage" IS NOT NULL))
);

ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_values_check" CHECK (
  length(btrim("name")) BETWEEN 3 AND 120
  AND ("stageFilter" IS NULL OR "trigger" = 'OPPORTUNITY_STAGE_CHANGED')
  AND (("action" = 'CREATE_TASK') = ("taskTitle" IS NOT NULL))
  AND ("taskTitle" IS NULL OR length(btrim("taskTitle")) BETWEEN 3 AND 200)
  AND ("action" = 'CREATE_TASK' OR ("taskAssigneeId" IS NULL AND "taskDueInDays" IS NULL))
  AND ("taskDueInDays" IS NULL OR "taskDueInDays" BETWEEN 0 AND 365)
  AND (("action" = 'NOTIFY_ADMINS') = ("message" IS NOT NULL))
  AND ("message" IS NULL OR length(btrim("message")) BETWEEN 3 AND 500)
  AND ("status" <> 'ACTIVE' OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "activatedAt" IS NOT NULL))
  AND ("status" <> 'DISABLED' OR "disabledAt" IS NOT NULL)
  AND length(btrim("createdById")) > 0
);

ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_values_check" CHECK (
  length("eventKey") BETWEEN 3 AND 200
  AND length("detail") BETWEEN 1 AND 500
  AND "notified" >= 0
  AND ("status" = 'DONE' OR ("taskId" IS NULL AND "notified" = 0))
);

-- ── Déclencheurs (ajouts manuels) ────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION lot_e_history_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lot E history immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER opportunity_events_immutable BEFORE UPDATE OR DELETE ON "opportunity_events"
  FOR EACH ROW EXECUTE FUNCTION lot_e_history_immutable();
CREATE TRIGGER opportunity_events_no_truncate BEFORE TRUNCATE ON "opportunity_events"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_e_history_immutable();
CREATE TRIGGER automation_runs_immutable BEFORE UPDATE OR DELETE ON "automation_runs"
  FOR EACH ROW EXECUTE FUNCTION lot_e_history_immutable();
CREATE TRIGGER automation_runs_no_truncate BEFORE TRUNCATE ON "automation_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_e_history_immutable();
CREATE TRIGGER opportunities_no_truncate BEFORE TRUNCATE ON "opportunities"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_e_history_immutable();
CREATE TRIGGER automation_rules_no_truncate BEFORE TRUNCATE ON "automation_rules"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_e_history_immutable();

-- Opportunité : jamais supprimée ; identité figée ; gagnée ou perdue = figée ; consultation liée de la MÊME entreprise
-- (la table des consultations n'a pas de clé composite : contrôle ici, sans la modifier).
CREATE FUNCTION opportunity_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'opportunity cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."id", NEW."companyId", NEW."number", NEW."createdById", NEW."createdAt")
       IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."number", OLD."createdById", OLD."createdAt") THEN
      RAISE EXCEPTION 'opportunity identity immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD."stage" IN ('WON', 'LOST') THEN
      RAISE EXCEPTION 'closed opportunity immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."consultationDraftId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."consultationDraftId" IS DISTINCT FROM OLD."consultationDraftId") THEN
    IF NOT EXISTS (SELECT 1 FROM "worksite_import_drafts" d WHERE d."id" = NEW."consultationDraftId" AND d."companyId" = NEW."companyId") THEN
      RAISE EXCEPTION 'opportunity consultation must belong to the same company' USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER opportunities_guard BEFORE INSERT OR UPDATE OR DELETE ON "opportunities"
  FOR EACH ROW EXECUTE FUNCTION opportunity_guard();

-- Règle d'automatisation : jamais supprimée ; configuration figée après création (modifier = désactiver puis créer
-- une nouvelle règle) ; transitions DRAFT → ACTIVE, ACTIVE → DISABLED, DISABLED → ACTIVE seulement.
CREATE FUNCTION automation_rule_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'automation rule cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."name", NEW."trigger", NEW."stageFilter", NEW."action", NEW."taskTitle", NEW."taskAssigneeId", NEW."taskDueInDays", NEW."message", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."name", OLD."trigger", OLD."stageFilter", OLD."action", OLD."taskTitle", OLD."taskAssigneeId", OLD."taskDueInDays", OLD."message", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'automation rule configuration immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE')
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'DISABLED')
    OR (OLD."status" = 'DISABLED' AND NEW."status" = 'ACTIVE')
  ) THEN
    RAISE EXCEPTION 'automation rule status transition not allowed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_rules_guard BEFORE UPDATE OR DELETE ON "automation_rules"
  FOR EACH ROW EXECUTE FUNCTION automation_rule_guard();

-- Exécution : seulement pour une règle ACTIVE au moment de l'écriture (désactivation immédiate, y compris pour un
-- exécuteur concurrent qui aurait lu la règle avant sa désactivation).
CREATE FUNCTION automation_run_rule_active() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "automation_rules" r WHERE r."id" = NEW."ruleId" AND r."companyId" = NEW."companyId" AND r."status" = 'ACTIVE') THEN
    RAISE EXCEPTION 'automation rule is not active' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER automation_runs_rule_active BEFORE INSERT ON "automation_runs"
  FOR EACH ROW EXECUTE FUNCTION automation_run_rule_active();

COMMIT;
