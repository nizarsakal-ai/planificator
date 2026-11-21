-- 22/11/2026 — PLAN-INTEGRATION-PLATFORM-001 LOT-8B : connexions réelles en lecture seule (Shopify, Mailchimp, Slack).
-- Migration ADDITIVE : une colonne nullable, un index, une clé étrangère ; contraintes et déclencheurs du lot F élargis
-- au mode LIVE. Aucune donnée existante modifiée. À appliquer avec le rôle propriétaire (docs/runbooks/DB-APP-ROLE.md).

-- AlterTable
ALTER TABLE "connector_settings" ADD COLUMN     "connectionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "connector_settings_companyId_connectionId_key" ON "connector_settings"("companyId", "connectionId");

-- AddForeignKey
ALTER TABLE "connector_settings" ADD CONSTRAINT "connector_settings_connectionId_companyId_fkey" FOREIGN KEY ("connectionId", "companyId") REFERENCES "integration_connections"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── Contraintes (ajouts manuels) ────────────────────────────────────────────────────────────────────────────────
-- Le mode LIVE n'existe que pour les connecteurs à adaptateur réel, et seulement adossé à une connexion.
ALTER TABLE "connector_settings" ADD CONSTRAINT "connector_settings_live_check" CHECK (
  "mode" <> 'LIVE' OR ("connectionId" IS NOT NULL AND "connectorKey" IN ('shopify', 'mailchimp', 'slack'))
);

-- Journal des synchronisations : modes SIMULATION et LIVE ; deux codes d'erreur de source réelle en plus.
ALTER TABLE "connector_sync_runs" DROP CONSTRAINT "connector_sync_runs_values_check";
ALTER TABLE "connector_sync_runs" ADD CONSTRAINT "connector_sync_runs_values_check" CHECK (
  "mode" IN ('SIMULATION', 'LIVE')
  AND "connectorKey" IN ('shopify', 'stripe', 'mailchimp', 'meta_ads', 'google_ads', 'slack', 'chatgpt', 'google_calendar', 'outlook', 'sharepoint')
  AND length(btrim("triggeredById")) > 0
  AND "finishedAt" >= "startedAt"
  AND "received" >= 0 AND "created" >= 0 AND "updated" >= 0 AND "unchanged" >= 0
  AND "received" = "created" + "updated" + "unchanged"
  AND ("watermarkBefore" IS NULL OR length("watermarkBefore") <= 4000)
  AND ("watermarkAfter" IS NULL OR length("watermarkAfter") <= 4000)
  AND (
    ("status" = 'SUCCEEDED' AND "errorCode" IS NULL)
    OR ("status" = 'FAILED' AND "errorCode" IS NOT NULL AND "errorCode" IN ('SOURCE_UNAVAILABLE', 'SOURCE_ITEM_INVALID', 'WATERMARK_INVALID', 'REAL_CONNECTION_DISABLED', 'INTERNAL_ERROR', 'AUTH_FAILED', 'RATE_LIMITED') AND "received" = 0
        AND "watermarkAfter" IS NOT DISTINCT FROM "watermarkBefore")
  )
);

-- ── Déclencheurs (remplacements et ajouts manuels) ──────────────────────────────────────────────────────────────
-- Réglage : identité figée (inchangé) ; la connexion liée ne change plus une fois attribuée ; passage en LIVE seulement si
-- la connexion de la même société est sous PLATFORM_ENCRYPTED, du même type, ACTIVE, avec des identifiants ACTIVE.
CREATE OR REPLACE FUNCTION connector_setting_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'connector setting cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."connectorKey", NEW."createdAt") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."connectorKey", OLD."createdAt") THEN
    RAISE EXCEPTION 'connector setting identity immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."connectionId" IS NOT NULL AND NEW."connectionId" IS DISTINCT FROM OLD."connectionId" THEN
    RAISE EXCEPTION 'connector setting connection immutable once assigned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION connector_setting_live_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."mode" = 'LIVE' AND NOT EXISTS (
    SELECT 1 FROM "integration_connections" c
    WHERE c."id" = NEW."connectionId" AND c."companyId" = NEW."companyId" AND c."connectorType" = NEW."connectorKey"
      AND c."secretBackend" = 'PLATFORM_ENCRYPTED' AND c."status" = 'ACTIVE' AND c."credentialStatus" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'live mode requires an active PLATFORM_ENCRYPTED connection with active credentials' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_settings_live_guard BEFORE INSERT OR UPDATE ON "connector_settings"
  FOR EACH ROW EXECUTE FUNCTION connector_setting_live_guard();

-- Synchronisation réussie : le mode journalisé est celui du réglage au moment de l'écriture (SIMULATION ou LIVE).
CREATE OR REPLACE FUNCTION connector_sync_run_mode() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'SUCCEEDED' AND NOT EXISTS (
    SELECT 1 FROM "connector_settings" s
    WHERE s."id" = NEW."settingId" AND s."companyId" = NEW."companyId" AND s."connectorKey" = NEW."connectorKey"
      AND s."mode" = NEW."mode" AND s."mode" IN ('SIMULATION', 'LIVE')
  ) THEN
    RAISE EXCEPTION 'connector is not in the logged sync mode' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Zone de transit : réception en SIMULATION ou en LIVE ; le reste des règles est inchangé.
CREATE OR REPLACE FUNCTION connector_staged_record_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staged record cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "connector_settings" s
    WHERE s."companyId" = NEW."companyId" AND s."connectorKey" = NEW."connectorKey" AND s."mode" IN ('SIMULATION', 'LIVE')
  ) THEN
    RAISE EXCEPTION 'connector is not in simulation or live mode' USING ERRCODE = '23514';
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
