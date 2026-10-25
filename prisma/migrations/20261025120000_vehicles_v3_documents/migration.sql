-- VEHICLES V3 LOT 1 — Coffre documentaire privé par camion. Migration PRÉPARÉE, NON EXÉCUTÉE
-- sur staging/production : toute exécution reste soumise à une autorisation distincte.
-- Additif : cinq tables, un type, un index composite sur vehicle_maintenance_entries,
-- deux valeurs d'énumération de notification. Aucune donnée V1/V2 réécrite, aucun backfill.
--
-- Contrat applicatif : commandes en READ COMMITTED sous verrou Truck FOR UPDATE (vehicle-authority),
-- autorisation effective relue, idempotence (clé UUID + empreinte), révision du dossier,
-- publication de la version après téléversement. Les triggers protègent l'immuabilité des
-- versions, des reçus de rappel et du journal d'audit ; ils ne remplacent pas le service.
-- Ne pas utiliser db push : il omet CHECK, index partiels et triggers.

-- 0a. Valeurs d'énumération : hors transaction (ADD VALUE n'est pas utilisable dans la
-- transaction qui l'ajoute). Idempotent et inoffensif si le reste échoue.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VEHICLE_DOCUMENT_EXPIRING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VEHICLE_DOCUMENT_EXPIRED';

BEGIN;

SET LOCAL lock_timeout = '5s';

LOCK TABLE "trucks", "vehicle_maintenance_entries" IN SHARE ROW EXCLUSIVE MODE;

-- 0b. Gardes sans mutation : prérequis V1/V2 présents, aucun objet V3 existant.
DO $$
BEGIN
  IF to_regclass('"trucks"') IS NULL OR to_regclass('"vehicle_maintenance_entries"') IS NULL
     OR to_regclass('"mileage_entries"') IS NULL OR to_regclass('"notifications"') IS NULL THEN
    RAISE EXCEPTION 'VEHICLES_V3: prérequis V1/V2 manquant (trucks, entretien, kilométrage, notifications).';
  END IF;
  IF to_regclass('"trucks_id_companyId_key"') IS NULL THEN
    RAISE EXCEPTION 'VEHICLES_V3: index composite trucks(id, companyId) manquant (migration V2 kilométrage).';
  END IF;
  IF to_regtype('"VehicleDocumentCategory"') IS NOT NULL
     OR to_regclass('"vehicle_documents"') IS NOT NULL
     OR to_regclass('"vehicle_document_versions"') IS NOT NULL
     OR to_regclass('"vehicle_document_reminder_settings"') IS NOT NULL
     OR to_regclass('"vehicle_document_reminders"') IS NOT NULL
     OR to_regclass('"vehicle_audit_logs"') IS NOT NULL
     OR to_regclass('"vehicle_maintenance_entries_id_truck_company_key"') IS NOT NULL THEN
    RAISE EXCEPTION 'VEHICLES_V3: objet du lot Documents déjà présent.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = current_schema()::regnamespace AND proname LIKE 'vehicle_documents_v3_%'
  ) THEN
    RAISE EXCEPTION 'VEHICLES_V3: fonction trigger V3 déjà présente.';
  END IF;
END $$;

-- 1. Structures additives.
CREATE TYPE "VehicleDocumentCategory" AS ENUM ('TECHNICAL_INSPECTION', 'REPAIR_MAINTENANCE', 'REGISTRATION', 'INSURANCE');

-- Cible de la FK composite tenant-safe des pièces rattachées à une intervention V2.
CREATE UNIQUE INDEX "vehicle_maintenance_entries_id_truck_company_key"
  ON "vehicle_maintenance_entries"("id", "truckId", "companyId");

CREATE TABLE "vehicle_documents" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "truckId" TEXT NOT NULL,
  "category" "VehicleDocumentCategory" NOT NULL,
  "title" TEXT NOT NULL,
  "currentVersionId" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "archivedAt" TIMESTAMPTZ(3),
  "archivedById" TEXT,
  "archivedByNameSnapshot" TEXT,
  "archiveReason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "createdById" TEXT NOT NULL,
  "createdByNameSnapshot" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "vehicle_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vehicle_document_versions" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "truckId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "storageProvider" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "storageResourceType" TEXT NOT NULL,
  "storageDeliveryType" TEXT NOT NULL,
  "originalFilename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "issuedOn" DATE,
  "validFrom" DATE,
  "validUntil" DATE,
  "issuerName" TEXT,
  "referenceNumber" TEXT,
  "observations" TEXT,
  "mileage" INTEGER,
  "maintenanceEntryId" TEXT,
  "uploadedById" TEXT NOT NULL,
  "uploadedByNameSnapshot" TEXT NOT NULL,
  "uploadedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "verifiedAt" TIMESTAMPTZ(3),
  "verifiedById" TEXT,
  "verifiedByNameSnapshot" TEXT,
  "supersededAt" TIMESTAMPTZ(3),
  "idempotencyKey" UUID NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  CONSTRAINT "vehicle_document_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vehicle_document_reminder_settings" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "thresholdsDays" INTEGER[] NOT NULL DEFAULT ARRAY[30, 7]::INTEGER[],
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedById" TEXT NOT NULL,
  "updatedByNameSnapshot" TEXT NOT NULL,
  CONSTRAINT "vehicle_document_reminder_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vehicle_document_reminders" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "truckId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "thresholdDays" INTEGER NOT NULL,
  "dueOn" DATE NOT NULL,
  "recipientUserId" TEXT NOT NULL,
  "notificationId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "vehicle_document_reminders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vehicle_audit_logs" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "truckId" TEXT,
  "actorId" TEXT NOT NULL,
  "actorNameSnapshot" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "outcome" TEXT NOT NULL,
  "detail" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "vehicle_audit_logs_pkey" PRIMARY KEY ("id")
);

-- 2. Unicités et index.
CREATE UNIQUE INDEX "vehicle_documents_id_truck_company_key" ON "vehicle_documents"("id", "truckId", "companyId");
CREATE UNIQUE INDEX "vehicle_documents_current_version_document_company_key" ON "vehicle_documents"("currentVersionId", "id", "companyId");
CREATE INDEX "vehicle_documents_companyId_truckId_category_idx" ON "vehicle_documents"("companyId", "truckId", "category");

CREATE UNIQUE INDEX "vehicle_document_versions_id_document_company_key" ON "vehicle_document_versions"("id", "documentId", "companyId");
CREATE UNIQUE INDEX "vehicle_document_versions_document_number_key" ON "vehicle_document_versions"("documentId", "versionNumber");
CREATE UNIQUE INDEX "vehicle_document_versions_company_truck_idempotency_key" ON "vehicle_document_versions"("companyId", "truckId", "idempotencyKey");
CREATE UNIQUE INDEX "vehicle_document_versions_company_storage_key" ON "vehicle_document_versions"("companyId", "storageKey");
CREATE INDEX "vehicle_document_versions_companyId_validUntil_idx" ON "vehicle_document_versions"("companyId", "validUntil");
CREATE INDEX "vehicle_document_versions_maintenance_entry_idx" ON "vehicle_document_versions"("maintenanceEntryId", "truckId", "companyId");

CREATE UNIQUE INDEX "vehicle_document_reminder_settings_companyId_key" ON "vehicle_document_reminder_settings"("companyId");

CREATE UNIQUE INDEX "vehicle_document_reminders_version_threshold_recipient_key" ON "vehicle_document_reminders"("versionId", "thresholdDays", "recipientUserId");
CREATE INDEX "vehicle_document_reminders_companyId_truckId_idx" ON "vehicle_document_reminders"("companyId", "truckId");

CREATE INDEX "vehicle_audit_logs_companyId_truckId_createdAt_idx" ON "vehicle_audit_logs"("companyId", "truckId", "createdAt");
CREATE INDEX "vehicle_audit_logs_companyId_entityType_entityId_idx" ON "vehicle_audit_logs"("companyId", "entityType", "entityId");

-- 3. FK : toutes RESTRICT, tenant cohérent en base par clés composites.
ALTER TABLE "vehicle_documents"
  ADD CONSTRAINT "vehicle_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_documents_truckId_companyId_fkey" FOREIGN KEY ("truckId", "companyId") REFERENCES "trucks"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_documents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "vehicle_document_versions"
  ADD CONSTRAINT "vehicle_document_versions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_document_versions_truckId_companyId_fkey" FOREIGN KEY ("truckId", "companyId") REFERENCES "trucks"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_document_versions_document_truck_company_fkey" FOREIGN KEY ("documentId", "truckId", "companyId") REFERENCES "vehicle_documents"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_document_versions_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_document_versions_maintenance_entry_fkey" FOREIGN KEY ("maintenanceEntryId", "truckId", "companyId") REFERENCES "vehicle_maintenance_entries"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "vehicle_documents"
  ADD CONSTRAINT "vehicle_documents_current_version_fkey" FOREIGN KEY ("currentVersionId", "id", "companyId") REFERENCES "vehicle_document_versions"("id", "documentId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "vehicle_document_reminder_settings"
  ADD CONSTRAINT "vehicle_document_reminder_settings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "vehicle_document_reminders"
  ADD CONSTRAINT "vehicle_document_reminders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_document_reminders_truckId_companyId_fkey" FOREIGN KEY ("truckId", "companyId") REFERENCES "trucks"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_document_reminders_document_fkey" FOREIGN KEY ("documentId", "truckId", "companyId") REFERENCES "vehicle_documents"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_document_reminders_version_fkey" FOREIGN KEY ("versionId", "documentId", "companyId") REFERENCES "vehicle_document_versions"("id", "documentId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "vehicle_audit_logs"
  ADD CONSTRAINT "vehicle_audit_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "vehicle_audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 4. CHECK locaux (aucune lecture d'une autre ligne).
ALTER TABLE "vehicle_documents"
  ADD CONSTRAINT "vehicle_documents_v3_values_check" CHECK (
    btrim("title") <> '' AND char_length("title") <= 200
    AND "revision" >= 1
    AND btrim("createdByNameSnapshot") <> ''
    AND ("archiveReason" IS NULL OR char_length("archiveReason") <= 2000)
    AND (("archivedAt" IS NULL AND "archivedById" IS NULL AND "archivedByNameSnapshot" IS NULL)
      OR ("archivedAt" IS NOT NULL AND "archivedById" IS NOT NULL AND "archivedByNameSnapshot" IS NOT NULL))
  );

ALTER TABLE "vehicle_document_versions"
  ADD CONSTRAINT "vehicle_document_versions_v3_values_check" CHECK (
    "versionNumber" >= 1
    AND "storageProvider" = 'cloudinary' AND "storageResourceType" = 'raw' AND "storageDeliveryType" = 'authenticated'
    AND btrim("storageKey") <> '' AND char_length("storageKey") <= 512
    AND btrim("originalFilename") <> '' AND char_length("originalFilename") <= 255
    AND btrim("mimeType") <> '' AND "sizeBytes" > 0
    AND "sha256" ~ '^[0-9a-f]{64}$' AND "requestHash" ~ '^[0-9a-f]{64}$'
    AND ("mileage" IS NULL OR "mileage" BETWEEN 0 AND 9999999)
    AND ("observations" IS NULL OR char_length("observations") <= 2000)
    AND ("issuerName" IS NULL OR char_length("issuerName") <= 200)
    AND ("referenceNumber" IS NULL OR char_length("referenceNumber") <= 100)
    AND ("validFrom" IS NULL OR "validUntil" IS NULL OR "validFrom" <= "validUntil")
    AND btrim("uploadedByNameSnapshot") <> ''
    AND (("verifiedAt" IS NULL AND "verifiedById" IS NULL AND "verifiedByNameSnapshot" IS NULL)
      OR ("verifiedAt" IS NOT NULL AND "verifiedById" IS NOT NULL AND "verifiedByNameSnapshot" IS NOT NULL))
  );

ALTER TABLE "vehicle_document_reminder_settings"
  ADD CONSTRAINT "vehicle_document_reminder_settings_v3_values_check" CHECK (
    "revision" >= 1 AND cardinality("thresholdsDays") BETWEEN 1 AND 6
    AND 0 <= ALL("thresholdsDays") AND 3650 >= ALL("thresholdsDays")
    AND btrim("updatedByNameSnapshot") <> ''
  );

ALTER TABLE "vehicle_document_reminders"
  ADD CONSTRAINT "vehicle_document_reminders_v3_values_check" CHECK ("thresholdDays" BETWEEN -1 AND 3650);

ALTER TABLE "vehicle_audit_logs"
  ADD CONSTRAINT "vehicle_audit_logs_v3_values_check" CHECK (
    btrim("action") <> '' AND btrim("entityType") <> '' AND btrim("actorNameSnapshot") <> ''
    AND "outcome" IN ('GRANTED', 'DENIED', 'DONE', 'FAILED')
  );

-- 5. Immuabilité : versions (hors validation humaine et remplacement), reçus et audit en ajout seul,
--    dossiers jamais supprimés, identité du dossier figée.
CREATE FUNCTION "vehicle_documents_v3_guard_version"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VEHICLES_V3: une version de document ne se supprime pas.'
      USING ERRCODE = '23514', CONSTRAINT = 'vehicle_document_versions_v3_immutable_check';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."uploadedAt" := clock_timestamp();
    IF NEW."supersededAt" IS NOT NULL THEN
      RAISE EXCEPTION 'VEHICLES_V3: une version est créée courante.'
        USING ERRCODE = '23514', CONSTRAINT = 'vehicle_document_versions_v3_initial_check';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."id", NEW."companyId", NEW."truckId", NEW."documentId", NEW."versionNumber",
         NEW."storageProvider", NEW."storageKey", NEW."storageResourceType", NEW."storageDeliveryType",
         NEW."originalFilename", NEW."mimeType", NEW."sizeBytes", NEW."sha256",
         NEW."issuedOn", NEW."validFrom", NEW."validUntil", NEW."issuerName", NEW."referenceNumber", NEW."observations",
         NEW."mileage", NEW."maintenanceEntryId", NEW."uploadedById", NEW."uploadedByNameSnapshot", NEW."uploadedAt",
         NEW."idempotencyKey", NEW."requestHash")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."companyId", OLD."truckId", OLD."documentId", OLD."versionNumber",
         OLD."storageProvider", OLD."storageKey", OLD."storageResourceType", OLD."storageDeliveryType",
         OLD."originalFilename", OLD."mimeType", OLD."sizeBytes", OLD."sha256",
         OLD."issuedOn", OLD."validFrom", OLD."validUntil", OLD."issuerName", OLD."referenceNumber", OLD."observations",
         OLD."mileage", OLD."maintenanceEntryId", OLD."uploadedById", OLD."uploadedByNameSnapshot", OLD."uploadedAt",
         OLD."idempotencyKey", OLD."requestHash")
     OR (OLD."verifiedAt" IS NOT NULL AND ROW(NEW."verifiedAt", NEW."verifiedById", NEW."verifiedByNameSnapshot")
         IS DISTINCT FROM ROW(OLD."verifiedAt", OLD."verifiedById", OLD."verifiedByNameSnapshot"))
     OR (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt")
     OR (OLD."supersededAt" IS NULL AND NEW."supersededAt" IS NOT NULL AND NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt") THEN
    RAISE EXCEPTION 'VEHICLES_V3: version immuable ; seules la validation humaine puis le remplacement sont autorisés.'
      USING ERRCODE = '23514', CONSTRAINT = 'vehicle_document_versions_v3_immutable_check';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER "vehicle_document_versions_v3_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_document_versions" FOR EACH ROW
  EXECUTE FUNCTION "vehicle_documents_v3_guard_version"();

CREATE FUNCTION "vehicle_documents_v3_guard_document"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VEHICLES_V3: un dossier documentaire se remplace ou s''archive, il ne se supprime pas.'
      USING ERRCODE = '23514', CONSTRAINT = 'vehicle_documents_v3_immutable_check';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF ROW(NEW."id", NEW."companyId", NEW."truckId", NEW."category", NEW."createdAt", NEW."createdById", NEW."createdByNameSnapshot")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."companyId", OLD."truckId", OLD."category", OLD."createdAt", OLD."createdById", OLD."createdByNameSnapshot")
     OR NEW."revision" < OLD."revision"
     OR (OLD."archivedAt" IS NOT NULL AND NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt") THEN
    RAISE EXCEPTION 'VEHICLES_V3: identité du dossier, révision décroissante ou désarchivage interdits.'
      USING ERRCODE = '23514', CONSTRAINT = 'vehicle_documents_v3_identity_check';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER "vehicle_documents_v3_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_documents" FOR EACH ROW
  EXECUTE FUNCTION "vehicle_documents_v3_guard_document"();

CREATE FUNCTION "vehicle_documents_v3_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'VEHICLES_V3: % en ajout seul.', TG_TABLE_NAME
    USING ERRCODE = '23514', CONSTRAINT = 'vehicle_documents_v3_append_only_check';
END;
$fn$;

CREATE TRIGGER "vehicle_document_reminders_v3_append_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_document_reminders" FOR EACH ROW
  EXECUTE FUNCTION "vehicle_documents_v3_append_only"();
CREATE TRIGGER "vehicle_audit_logs_v3_append_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "vehicle_audit_logs" FOR EACH ROW
  EXECUTE FUNCTION "vehicle_documents_v3_append_only"();

-- 6. Assertions finales : aucune donnée inventée, FK RESTRICT, CHECK, index et triggers actifs.
DO $$
DECLARE
  object_name text;
  n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM "vehicle_documents") OR EXISTS (SELECT 1 FROM "vehicle_document_versions")
     OR EXISTS (SELECT 1 FROM "vehicle_document_reminders") OR EXISTS (SELECT 1 FROM "vehicle_document_reminder_settings")
     OR EXISTS (SELECT 1 FROM "vehicle_audit_logs") THEN
    RAISE EXCEPTION 'VEHICLES_V3: données initiales inattendues (aucun backfill autorisé).';
  END IF;

  FOREACH object_name IN ARRAY ARRAY[
    'vehicle_documents_companyId_fkey', 'vehicle_documents_truckId_companyId_fkey', 'vehicle_documents_createdById_fkey',
    'vehicle_documents_current_version_fkey',
    'vehicle_document_versions_companyId_fkey', 'vehicle_document_versions_truckId_companyId_fkey',
    'vehicle_document_versions_document_truck_company_fkey', 'vehicle_document_versions_uploadedById_fkey',
    'vehicle_document_versions_maintenance_entry_fkey',
    'vehicle_document_reminder_settings_companyId_fkey',
    'vehicle_document_reminders_companyId_fkey', 'vehicle_document_reminders_truckId_companyId_fkey',
    'vehicle_document_reminders_document_fkey', 'vehicle_document_reminders_version_fkey',
    'vehicle_audit_logs_companyId_fkey', 'vehicle_audit_logs_actorId_fkey'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE connamespace = current_schema()::regnamespace
        AND conname = object_name AND contype = 'f' AND convalidated AND confdeltype = 'r' AND confupdtype = 'r'
    ) THEN
      RAISE EXCEPTION 'VEHICLES_V3: FK RESTRICT non conforme : %.', object_name;
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO n FROM pg_constraint
  WHERE convalidated AND contype = 'c' AND conname IN (
    'vehicle_documents_v3_values_check', 'vehicle_document_versions_v3_values_check',
    'vehicle_document_reminder_settings_v3_values_check', 'vehicle_document_reminders_v3_values_check',
    'vehicle_audit_logs_v3_values_check');
  IF n <> 5 THEN RAISE EXCEPTION 'VEHICLES_V3: CHECK manquants ou non validés (% / 5).', n; END IF;

  FOREACH object_name IN ARRAY ARRAY[
    'vehicle_maintenance_entries_id_truck_company_key',
    'vehicle_documents_id_truck_company_key', 'vehicle_documents_current_version_document_company_key',
    'vehicle_document_versions_id_document_company_key', 'vehicle_document_versions_document_number_key',
    'vehicle_document_versions_company_truck_idempotency_key', 'vehicle_document_versions_company_storage_key',
    'vehicle_document_reminder_settings_companyId_key', 'vehicle_document_reminders_version_threshold_recipient_key'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass(format('%I', object_name)) AND indisunique AND indisvalid) THEN
      RAISE EXCEPTION 'VEHICLES_V3: index unique non conforme : %.', object_name;
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND tgname IN (
    'vehicle_document_versions_v3_guard', 'vehicle_documents_v3_guard',
    'vehicle_document_reminders_v3_append_only', 'vehicle_audit_logs_v3_append_only');
  IF n <> 4 THEN RAISE EXCEPTION 'VEHICLES_V3: triggers manquants ou désactivés (% / 4).', n; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = '"NotificationType"'::regtype AND enumlabel = 'VEHICLE_DOCUMENT_EXPIRING')
     OR NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumtypid = '"NotificationType"'::regtype AND enumlabel = 'VEHICLE_DOCUMENT_EXPIRED') THEN
    RAISE EXCEPTION 'VEHICLES_V3: valeurs de notification manquantes.';
  END IF;
END $$;

COMMIT;
