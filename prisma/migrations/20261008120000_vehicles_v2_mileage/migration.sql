-- VEHICLES V2 LOT 1 — Journal kilométrique et trajets. Migration NON EXÉCUTÉE.
-- Additif : deux tables, projection Truck initialement inconnue, aucune donnée V1 réécrite.
-- Les uniques (id, companyId) des parents servent uniquement de cibles aux FK tenant-safe.
-- Les FK historiques refusent DELETE et UPDATE des identités référencées.
--
-- Contrat : commandes du service en READ COMMITTED, verrou Truck FOR UPDATE,
-- puis autorisation, idempotence, révision, validation métier, journal et projection.
-- Les triggers ci-dessous protègent les liens immuables et archive/trajet ouvert.
-- Ils ne prétendent PAS vérifier la projection courante ni la monotonie effective
-- entre plusieurs relevés : ces règles sont validées sous verrou dans le service.
-- Les transitions archive/ouverture/clôture refusent les autres isolations, dont
-- le snapshot figé ne convient pas à la relecture du trajet après attente du verrou.
-- Aucun trigger TRUNCATE ni infrastructure générique d'event sourcing.
--
-- Déploiement futur : migration AVANT le code qui sélectionne les colonnes V2.
-- Ne pas utiliser db push : il omet CHECK, index partiel et triggers.
-- Échec : transaction entière annulée ; lire le diagnostic, corriger explicitement
-- sa cause puis suivre le processus de migration approuvé. Aucune correction automatique.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Les verrous précèdent les gardes et restent détenus jusqu'au COMMIT.
LOCK TABLE "employees", "teams", "trucks", "worksites" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "companies", "users" IN SHARE ROW EXCLUSIVE MODE;

-- 0. Gardes sans mutation : version V1 attendue et absence de tout objet V2.
DO $$
DECLARE
  parent_name text;
  n integer;
BEGIN
  IF to_regclass('"mileage_entries"') IS NOT NULL OR to_regclass('"mileage_trips"') IS NOT NULL
     OR to_regtype('"MileageEntryKind"') IS NOT NULL THEN
    RAISE EXCEPTION 'VEHICLES_V2: table ou enum V2 déjà présent.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '"trucks"'::regclass AND NOT attisdropped
      AND attname IN ('currentMileage', 'currentMileageEntryId', 'mileageRevision')
  ) THEN
    RAISE EXCEPTION 'VEHICLES_V2: colonne de projection déjà présente.';
  END IF;

  FOREACH parent_name IN ARRAY ARRAY['employees', 'teams', 'trucks', 'worksites'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = to_regclass(format('%I', parent_name))
        AND attname = 'companyId' AND attnotnull AND NOT attisdropped
    ) THEN
      RAISE EXCEPTION 'VEHICLES_V2: %.companyId obligatoire absent.', parent_name;
    END IF;
    IF to_regclass(format('%I', parent_name || '_id_companyId_key')) IS NOT NULL THEN
      RAISE EXCEPTION 'VEHICLES_V2: index composite % déjà présent.', parent_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relnamespace = current_schema()::regnamespace
      AND (relname LIKE 'mileage_entries_%' OR relname LIKE 'mileage_trips_%'
           OR relname = 'trucks_current_mileage_entry_truck_company_key')
  ) OR EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace = current_schema()::regnamespace
      AND (proname LIKE 'mileage_entries_v2_%' OR proname LIKE 'mileage_trips_v2_%'
           OR proname LIKE 'trucks_v2_%')
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = '"trucks"'::regclass AND tgname LIKE 'trucks_v2_%' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'VEHICLES_V2: collision avec un objet V2 existant.';
  END IF;

  SELECT COUNT(*) INTO n FROM pg_constraint
  WHERE convalidated AND contype = 'c' AND (
    (conrelid = '"trucks"'::regclass AND conname = 'trucks_v1a_archived_unassigned_check') OR
    (conrelid = '"truck_assignments"'::regclass AND conname IN
      ('truck_assignments_v1b_chronology_check', 'truck_assignments_v1b_reason_required_check'))
  );
  IF n <> 3 OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = '"truck_assignments"'::regclass
      AND tgname = 'truck_assignments_v1a_open_for_truck_id'
      AND NOT tgisinternal AND tgenabled <> 'D'
      AND tgfoid = to_regprocedure('"truck_assignments_v1a_sync_open_for_truck_id"()')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = '"trucks"'::regclass AND attname = 'modele' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'VEHICLES_V2: prérequis V1A / V1B-db / V1C manquant.';
  END IF;
END $$;

-- 1. Structures additives. Aucun INSERT/UPDATE/DELETE de données historiques.
CREATE TYPE "MileageEntryKind" AS ENUM ('READING', 'DEPARTURE', 'ARRIVAL', 'CORRECTION');

ALTER TABLE "trucks"
  ADD COLUMN "currentMileage" INTEGER,
  ADD COLUMN "currentMileageEntryId" TEXT,
  ADD COLUMN "mileageRevision" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "employees_id_companyId_key" ON "employees"("id", "companyId");
CREATE UNIQUE INDEX "teams_id_companyId_key" ON "teams"("id", "companyId");
CREATE UNIQUE INDEX "trucks_id_companyId_key" ON "trucks"("id", "companyId");
CREATE UNIQUE INDEX "worksites_id_companyId_key" ON "worksites"("id", "companyId");
CREATE UNIQUE INDEX "trucks_current_mileage_entry_truck_company_key"
  ON "trucks"("currentMileageEntryId", "id", "companyId");

CREATE TABLE "mileage_entries" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "truckId" TEXT NOT NULL,
  "kind" "MileageEntryKind" NOT NULL,
  "mileage" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL,
  "occurredAt" TIMESTAMPTZ(3),
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  "createdById" TEXT NOT NULL,
  "createdByNameSnapshot" TEXT NOT NULL,
  "rootEntryId" TEXT,
  "supersedesEntryId" TEXT,
  "correctionReason" TEXT,
  "idempotencyKey" UUID NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  CONSTRAINT "mileage_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mileage_trips" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "truckId" TEXT NOT NULL,
  "startEntryId" TEXT NOT NULL,
  "endEntryId" TEXT,
  "worksiteId" TEXT,
  "teamId" TEXT,
  "chauffeurId" TEXT,
  "worksiteNameSnapshot" TEXT,
  "teamNameSnapshot" TEXT,
  "chauffeurNameSnapshot" TEXT,
  CONSTRAINT "mileage_trips_pkey" PRIMARY KEY ("id")
);

-- 2. Unicités : révision/commande, chaîne sans branchement, endpoints, trajet ouvert.
CREATE UNIQUE INDEX "mileage_entries_id_truck_company_key" ON "mileage_entries"("id", "truckId", "companyId");
CREATE UNIQUE INDEX "mileage_entries_supersedes_truck_company_key" ON "mileage_entries"("supersedesEntryId", "truckId", "companyId");
CREATE UNIQUE INDEX "mileage_entries_company_truck_revision_key" ON "mileage_entries"("companyId", "truckId", "revision");
CREATE UNIQUE INDEX "mileage_entries_company_truck_idempotency_key" ON "mileage_entries"("companyId", "truckId", "idempotencyKey");
CREATE INDEX "mileage_entries_company_truck_occurred_idx" ON "mileage_entries"("companyId", "truckId", "occurredAt");
CREATE INDEX "mileage_entries_root_truck_company_idx" ON "mileage_entries"("rootEntryId", "truckId", "companyId");
CREATE INDEX "mileage_entries_createdById_idx" ON "mileage_entries"("createdById");

CREATE UNIQUE INDEX "mileage_trips_start_truck_company_key" ON "mileage_trips"("startEntryId", "truckId", "companyId");
CREATE UNIQUE INDEX "mileage_trips_end_truck_company_key" ON "mileage_trips"("endEntryId", "truckId", "companyId");
CREATE UNIQUE INDEX "mileage_trips_v2_open_truck_key" ON "mileage_trips"("companyId", "truckId") WHERE "endEntryId" IS NULL;
CREATE INDEX "mileage_trips_companyId_truckId_idx" ON "mileage_trips"("companyId", "truckId");
CREATE INDEX "mileage_trips_worksiteId_companyId_idx" ON "mileage_trips"("worksiteId", "companyId");
CREATE INDEX "mileage_trips_teamId_companyId_idx" ON "mileage_trips"("teamId", "companyId");
CREATE INDEX "mileage_trips_chauffeurId_companyId_idx" ON "mileage_trips"("chauffeurId", "companyId");

-- 3. FK historiques : aucune cascade, identités et tenant cohérents en base.
ALTER TABLE "mileage_entries"
  ADD CONSTRAINT "mileage_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "mileage_entries_truckId_companyId_fkey" FOREIGN KEY ("truckId", "companyId") REFERENCES "trucks"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "mileage_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "mileage_entries_root_truck_company_fkey" FOREIGN KEY ("rootEntryId", "truckId", "companyId") REFERENCES "mileage_entries"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "mileage_entries_supersedes_truck_company_fkey" FOREIGN KEY ("supersedesEntryId", "truckId", "companyId") REFERENCES "mileage_entries"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "mileage_trips"
  ADD CONSTRAINT "mileage_trips_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "mileage_trips_truckId_companyId_fkey" FOREIGN KEY ("truckId", "companyId") REFERENCES "trucks"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "mileage_trips_start_truck_company_fkey" FOREIGN KEY ("startEntryId", "truckId", "companyId") REFERENCES "mileage_entries"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "mileage_trips_end_truck_company_fkey" FOREIGN KEY ("endEntryId", "truckId", "companyId") REFERENCES "mileage_entries"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "mileage_trips_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "mileage_trips_teamId_companyId_fkey" FOREIGN KEY ("teamId", "companyId") REFERENCES "teams"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "mileage_trips_chauffeurId_companyId_fkey" FOREIGN KEY ("chauffeurId", "companyId") REFERENCES "employees"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "trucks" ADD CONSTRAINT "trucks_current_mileage_entry_fkey"
  FOREIGN KEY ("currentMileageEntryId", "id", "companyId") REFERENCES "mileage_entries"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 4. CHECK locaux uniquement (aucune lecture d'une autre ligne dans un CHECK).
ALTER TABLE "trucks"
  ADD CONSTRAINT "trucks_v2_mileage_projection_check" CHECK (
    ("currentMileage" IS NULL AND "currentMileageEntryId" IS NULL) OR
    ("currentMileage" IS NOT NULL AND "currentMileageEntryId" IS NOT NULL AND "currentMileage" BETWEEN 0 AND 9999999)
  ),
  ADD CONSTRAINT "trucks_v2_mileage_revision_check" CHECK ("mileageRevision" >= 0);

ALTER TABLE "mileage_entries"
  ADD CONSTRAINT "mileage_entries_v2_mileage_check" CHECK ("mileage" BETWEEN 0 AND 9999999),
  ADD CONSTRAINT "mileage_entries_v2_revision_check" CHECK ("revision" > 0),
  ADD CONSTRAINT "mileage_entries_v2_author_snapshot_check" CHECK (btrim("createdByNameSnapshot") <> ''),
  ADD CONSTRAINT "mileage_entries_v2_request_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "mileage_entries_v2_shape_check" CHECK (
    ("kind" IN ('READING', 'DEPARTURE', 'ARRIVAL') AND "occurredAt" IS NOT NULL
      AND "rootEntryId" IS NULL AND "supersedesEntryId" IS NULL AND "correctionReason" IS NULL) OR
    ("kind" = 'CORRECTION' AND "occurredAt" IS NULL
      AND "rootEntryId" IS NOT NULL AND "rootEntryId" <> "id"
      AND "supersedesEntryId" IS NOT NULL AND "supersedesEntryId" <> "id"
      AND "correctionReason" IS NOT NULL AND btrim("correctionReason") <> '')
  );

ALTER TABLE "mileage_trips"
  ADD CONSTRAINT "mileage_trips_v2_endpoints_check" CHECK ("endEntryId" IS NULL OR "startEntryId" <> "endEntryId"),
  ADD CONSTRAINT "mileage_trips_v2_context_check" CHECK (
    (("worksiteId" IS NULL AND "worksiteNameSnapshot" IS NULL) OR
     ("worksiteId" IS NOT NULL AND "worksiteNameSnapshot" IS NOT NULL AND btrim("worksiteNameSnapshot") <> '')) AND
    (("teamId" IS NULL AND "teamNameSnapshot" IS NULL) OR
     ("teamId" IS NOT NULL AND "teamNameSnapshot" IS NOT NULL AND btrim("teamNameSnapshot") <> '')) AND
    (("chauffeurId" IS NULL AND "chauffeurNameSnapshot" IS NULL) OR
     ("chauffeurId" IS NOT NULL AND "chauffeurNameSnapshot" IS NOT NULL AND btrim("chauffeurNameSnapshot") <> ''))
  );

-- 5. Journal immuable et chaîne de correction spécifique au kilométrage.
CREATE FUNCTION "mileage_entries_v2_validate_insert"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  root_row "mileage_entries"%ROWTYPE;
  previous_row "mileage_entries"%ROWTYPE;
BEGIN
  -- L'instant d'enregistrement ne peut pas être imposé par l'appelant.
  NEW."recordedAt" := clock_timestamp();
  IF NEW."kind" = 'CORRECTION' THEN
    SELECT * INTO root_row FROM "mileage_entries"
    WHERE "id" = NEW."rootEntryId" AND "truckId" = NEW."truckId" AND "companyId" = NEW."companyId";
    IF NOT FOUND OR root_row."kind" = 'CORRECTION' THEN
      RAISE EXCEPTION 'VEHICLES_V2: racine de correction invalide.'
        USING ERRCODE = '23514', CONSTRAINT = 'mileage_entries_v2_correction_root_check';
    END IF;
    SELECT * INTO previous_row FROM "mileage_entries"
    WHERE "id" = NEW."supersedesEntryId" AND "truckId" = NEW."truckId" AND "companyId" = NEW."companyId";
    IF NOT FOUND OR NOT (
      previous_row."id" = root_row."id" OR
      (previous_row."kind" = 'CORRECTION' AND previous_row."rootEntryId" = root_row."id")
    ) OR NEW."revision" <= previous_row."revision" THEN
      RAISE EXCEPTION 'VEHICLES_V2: prédécesseur de correction invalide.'
        USING ERRCODE = '23514', CONSTRAINT = 'mileage_entries_v2_correction_predecessor_check';
    END IF;
    -- L'unique supersedesEntryId/truckId/companyId arbitre aussi les INSERT concurrents.
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE FUNCTION "mileage_entries_v2_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'VEHICLES_V2: journal immuable ; ajouter une correction.'
    USING ERRCODE = '23514', CONSTRAINT = 'mileage_entries_v2_immutable_check';
END;
$fn$;

CREATE TRIGGER "mileage_entries_v2_insert"
  BEFORE INSERT ON "mileage_entries" FOR EACH ROW
  EXECUTE FUNCTION "mileage_entries_v2_validate_insert"();
CREATE TRIGGER "mileage_entries_v2_immutable"
  BEFORE UPDATE OR DELETE ON "mileage_entries" FOR EACH ROW
  EXECUTE FUNCTION "mileage_entries_v2_reject_mutation"();

-- 6. Trajet : ouverture puis une seule clôture ; contexte et départ immuables.
CREATE FUNCTION "mileage_trips_v2_guard"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  truck_active boolean;
  start_row "mileage_entries"%ROWTYPE;
  end_row "mileage_entries"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VEHICLES_V2: suppression de trajet interdite.'
      USING ERRCODE = '23514', CONSTRAINT = 'mileage_trips_v2_immutable_check';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW."id", NEW."companyId", NEW."truckId", NEW."startEntryId", NEW."worksiteId", NEW."teamId", NEW."chauffeurId",
           NEW."worksiteNameSnapshot", NEW."teamNameSnapshot", NEW."chauffeurNameSnapshot")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."companyId", OLD."truckId", OLD."startEntryId", OLD."worksiteId", OLD."teamId", OLD."chauffeurId",
           OLD."worksiteNameSnapshot", OLD."teamNameSnapshot", OLD."chauffeurNameSnapshot")
       OR OLD."endEntryId" IS NOT NULL OR NEW."endEntryId" IS NULL THEN
      RAISE EXCEPTION 'VEHICLES_V2: seule la clôture initiale du trajet est autorisée.'
        USING ERRCODE = '23514', CONSTRAINT = 'mileage_trips_v2_immutable_check';
    END IF;
  ELSIF NEW."endEntryId" IS NOT NULL THEN
    RAISE EXCEPTION 'VEHICLES_V2: un trajet est créé ouvert.'
      USING ERRCODE = '23514', CONSTRAINT = 'mileage_trips_v2_initial_open_check';
  END IF;

  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'VEHICLES_V2: transition trajet exige READ COMMITTED.' USING ERRCODE = '25000';
  END IF;
  SELECT "active" INTO truck_active FROM "trucks"
  WHERE "id" = NEW."truckId" AND "companyId" = NEW."companyId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VEHICLES_V2: véhicule du tenant introuvable.'
      USING ERRCODE = '23503', CONSTRAINT = 'mileage_trips_truckId_companyId_fkey';
  END IF;
  IF TG_OP = 'INSERT' AND NOT truck_active THEN
    RAISE EXCEPTION 'VEHICLES_V2: ouverture sur véhicule archivé interdite.'
      USING ERRCODE = '23514', CONSTRAINT = 'mileage_trips_v2_active_truck_check';
  END IF;

  SELECT * INTO start_row FROM "mileage_entries"
  WHERE "id" = NEW."startEntryId" AND "truckId" = NEW."truckId" AND "companyId" = NEW."companyId";
  IF NOT FOUND OR start_row."kind" <> 'DEPARTURE' OR start_row."rootEntryId" IS NOT NULL THEN
    RAISE EXCEPTION 'VEHICLES_V2: départ original invalide.'
      USING ERRCODE = '23514', CONSTRAINT = 'mileage_trips_v2_start_entry_check';
  END IF;
  IF NEW."endEntryId" IS NOT NULL THEN
    SELECT * INTO end_row FROM "mileage_entries"
    WHERE "id" = NEW."endEntryId" AND "truckId" = NEW."truckId" AND "companyId" = NEW."companyId";
    IF NOT FOUND OR end_row."kind" <> 'ARRIVAL' OR end_row."rootEntryId" IS NOT NULL
       OR end_row."occurredAt" < start_row."occurredAt" OR end_row."revision" <= start_row."revision" THEN
      RAISE EXCEPTION 'VEHICLES_V2: arrivée originale ou chronologie invalide.'
        USING ERRCODE = '23514', CONSTRAINT = 'mileage_trips_v2_end_entry_check';
    END IF;
    -- Ne pas comparer les valeurs brutes : le départ peut avoir été corrigé.
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER "mileage_trips_v2_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "mileage_trips" FOR EACH ROW
  EXECUTE FUNCTION "mileage_trips_v2_guard"();

-- UPDATE trucks détient déjà le verrou parent ; le trigger VOLATILE relit les
-- trajets après toute attente, avec un nouveau snapshot de commande en READ COMMITTED.
CREATE FUNCTION "trucks_v2_guard_archive"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'VEHICLES_V2: archivage exige READ COMMITTED.' USING ERRCODE = '25000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "mileage_trips"
    WHERE "truckId" = NEW."id" AND "companyId" = NEW."companyId" AND "endEntryId" IS NULL
  ) THEN
    RAISE EXCEPTION 'VEHICLES_V2: archivage impossible avec trajet ouvert.'
      USING ERRCODE = '23514', CONSTRAINT = 'trucks_v2_no_open_mileage_trip_check';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER "trucks_v2_no_open_mileage_trip"
  BEFORE UPDATE OF "active" ON "trucks" FOR EACH ROW WHEN (NEW."active" = false)
  EXECUTE FUNCTION "trucks_v2_guard_archive"();

-- 7. Assertions finales : pas de kilométrage inventé, FK/indices/CHECK/triggers actifs.
DO $$
DECLARE
  object_name text;
  n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM "mileage_entries") OR EXISTS (SELECT 1 FROM "mileage_trips")
     OR EXISTS (SELECT 1 FROM "trucks" WHERE "currentMileage" IS NOT NULL OR "currentMileageEntryId" IS NOT NULL OR "mileageRevision" <> 0) THEN
    RAISE EXCEPTION 'VEHICLES_V2: données initiales inattendues (aucun backfill autorisé).';
  END IF;

  FOREACH object_name IN ARRAY ARRAY[
    'mileage_entries_companyId_fkey', 'mileage_entries_truckId_companyId_fkey', 'mileage_entries_createdById_fkey',
    'mileage_entries_root_truck_company_fkey', 'mileage_entries_supersedes_truck_company_fkey',
    'mileage_trips_companyId_fkey', 'mileage_trips_truckId_companyId_fkey',
    'mileage_trips_start_truck_company_fkey', 'mileage_trips_end_truck_company_fkey',
    'mileage_trips_worksiteId_companyId_fkey', 'mileage_trips_teamId_companyId_fkey', 'mileage_trips_chauffeurId_companyId_fkey',
    'trucks_current_mileage_entry_fkey'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE connamespace = current_schema()::regnamespace
        AND conname = object_name AND contype = 'f' AND convalidated AND confdeltype = 'r' AND confupdtype = 'r'
    ) THEN
      RAISE EXCEPTION 'VEHICLES_V2: FK RESTRICT non conforme : %.', object_name;
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO n FROM pg_constraint
  WHERE convalidated AND contype = 'c' AND (
    (conrelid = '"trucks"'::regclass AND conname IN ('trucks_v2_mileage_projection_check', 'trucks_v2_mileage_revision_check')) OR
    (conrelid = '"mileage_entries"'::regclass AND conname IN ('mileage_entries_v2_mileage_check', 'mileage_entries_v2_revision_check',
      'mileage_entries_v2_author_snapshot_check', 'mileage_entries_v2_request_hash_check', 'mileage_entries_v2_shape_check')) OR
    (conrelid = '"mileage_trips"'::regclass AND conname IN ('mileage_trips_v2_endpoints_check', 'mileage_trips_v2_context_check'))
  );
  IF n <> 9 THEN RAISE EXCEPTION 'VEHICLES_V2: CHECK manquants ou non validés (% / 9).', n; END IF;

  FOREACH object_name IN ARRAY ARRAY[
    'employees_id_companyId_key', 'teams_id_companyId_key', 'trucks_id_companyId_key', 'worksites_id_companyId_key',
    'trucks_current_mileage_entry_truck_company_key', 'mileage_entries_id_truck_company_key',
    'mileage_entries_supersedes_truck_company_key', 'mileage_entries_company_truck_revision_key',
    'mileage_entries_company_truck_idempotency_key', 'mileage_trips_start_truck_company_key',
    'mileage_trips_end_truck_company_key', 'mileage_trips_v2_open_truck_key'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass(format('%I', object_name)) AND indisunique AND indisvalid) THEN
      RAISE EXCEPTION 'VEHICLES_V2: index unique non conforme : %.', object_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index WHERE indexrelid = '"mileage_trips_v2_open_truck_key"'::regclass
      AND pg_get_expr(indpred, indrelid) = '("endEntryId" IS NULL)'
  ) THEN RAISE EXCEPTION 'VEHICLES_V2: prédicat du trajet ouvert invalide.'; END IF;

  SELECT COUNT(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O' AND (
    (tgrelid = '"mileage_entries"'::regclass AND tgname IN ('mileage_entries_v2_insert', 'mileage_entries_v2_immutable')) OR
    (tgrelid = '"mileage_trips"'::regclass AND tgname = 'mileage_trips_v2_guard') OR
    (tgrelid = '"trucks"'::regclass AND tgname = 'trucks_v2_no_open_mileage_trip')
  );
  IF n <> 4 THEN RAISE EXCEPTION 'VEHICLES_V2: triggers manquants ou désactivés (% / 4).', n; END IF;
END $$;

COMMIT;
