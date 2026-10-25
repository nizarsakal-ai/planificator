-- CreateTable
CREATE TABLE "vehicle_tours" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "teamId" TEXT,
    "chauffeurId" TEXT,
    "teamNameSnapshot" TEXT,
    "chauffeurNameSnapshot" TEXT,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "estimatedKm" DOUBLE PRECISION,
    "mileageTripId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "vehicle_tours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_tour_stops" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "worksiteId" TEXT,
    "clientId" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "validatedById" TEXT NOT NULL,
    "validatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "vehicle_tour_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_tour_commands" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "key" UUID NOT NULL,
    "requestHash" TEXT NOT NULL,
    "acceptedRevision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_tour_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_tours_mileageTripId_key" ON "vehicle_tours"("mileageTripId");

-- CreateIndex
CREATE INDEX "vehicle_tours_companyId_truckId_startsAt_idx" ON "vehicle_tours"("companyId", "truckId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_tours_id_companyId_key" ON "vehicle_tours"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_tours_mileageTripId_truckId_companyId_key" ON "vehicle_tours"("mileageTripId", "truckId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_tour_stops_tourId_position_key" ON "vehicle_tour_stops"("tourId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_tour_commands_companyId_truckId_key_key" ON "vehicle_tour_commands"("companyId", "truckId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "mileage_trips_id_truckId_companyId_key" ON "mileage_trips"("id", "truckId", "companyId");

-- AddForeignKey
ALTER TABLE "vehicle_tours" ADD CONSTRAINT "vehicle_tours_truckId_companyId_fkey" FOREIGN KEY ("truckId", "companyId") REFERENCES "trucks"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_tours" ADD CONSTRAINT "vehicle_tours_mileageTripId_truckId_companyId_fkey" FOREIGN KEY ("mileageTripId", "truckId", "companyId") REFERENCES "mileage_trips"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_tour_stops" ADD CONSTRAINT "vehicle_tour_stops_tourId_companyId_fkey" FOREIGN KEY ("tourId", "companyId") REFERENCES "vehicle_tours"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_tour_commands" ADD CONSTRAINT "vehicle_tour_commands_tourId_companyId_fkey" FOREIGN KEY ("tourId", "companyId") REFERENCES "vehicle_tours"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE vehicle_tours ADD CONSTRAINT vehicle_tours_status_check CHECK(status IN ('PLANNED','IN_PROGRESS','COMPLETED','CANCELLED')),
 ADD CONSTRAINT vehicle_tours_interval_check CHECK("endsAt">"startsAt"),
 ADD CONSTRAINT vehicle_tours_trip_check CHECK((status IN ('PLANNED','CANCELLED') AND "mileageTripId" IS NULL) OR (status IN ('IN_PROGRESS','COMPLETED') AND "mileageTripId" IS NOT NULL));
ALTER TABLE vehicle_tour_stops ADD CONSTRAINT vehicle_tour_stops_position_check CHECK(position >= 0);
CREATE FUNCTION vehicle_tours_guard_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT NEW.active AND EXISTS(SELECT 1 FROM vehicle_tours WHERE "truckId"=NEW.id AND "companyId"=NEW."companyId" AND status IN ('PLANNED','IN_PROGRESS')) THEN
 RAISE EXCEPTION 'TRUCK_HAS_ACTIVE_TOUR' USING ERRCODE='23514', CONSTRAINT='trucks_v3_active_tour_check'; END IF; RETURN NEW; END $$;
CREATE TRIGGER trucks_v3_tour_archive_guard BEFORE UPDATE OF active ON trucks FOR EACH ROW EXECUTE FUNCTION vehicle_tours_guard_archive();
-- Journal de commandes immuable ; replay conserve le reçu de la révision acceptée.
CREATE FUNCTION vehicle_tour_commands_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable tour command' USING ERRCODE='23514'; END $$;
CREATE TRIGGER vehicle_tour_commands_immutable BEFORE UPDATE OR DELETE ON vehicle_tour_commands FOR EACH ROW EXECUTE FUNCTION vehicle_tour_commands_immutable();
ALTER TABLE vehicle_tours ADD CONSTRAINT vehicle_tours_team_company_fkey FOREIGN KEY("teamId","companyId") REFERENCES teams(id,"companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT vehicle_tours_driver_company_fkey FOREIGN KEY("chauffeurId","companyId") REFERENCES employees(id,"companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT vehicle_tours_author_fkey FOREIGN KEY("createdById") REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE vehicle_tour_stops ADD CONSTRAINT vehicle_tour_stops_worksite_company_fkey FOREIGN KEY("worksiteId","companyId") REFERENCES worksites(id,"companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT vehicle_tour_stops_client_company_fkey FOREIGN KEY("clientId","companyId") REFERENCES clients(id,"companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT vehicle_tour_stops_author_fkey FOREIGN KEY("validatedById") REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The existing planning keeps its unique team/day and employee/day constraints.
-- Its writes acquire the SAME company reservation lock, closing the check/insert race.
CREATE FUNCTION vehicle_tours_guard_team_planning() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant text; tz text; BEGIN
 SELECT "companyId" INTO tenant FROM teams WHERE id=NEW."teamId";
 SELECT COALESCE((SELECT timezone FROM company_settings WHERE "companyId"=tenant),'Europe/Paris') INTO tz;
 PERFORM pg_advisory_xact_lock(hashtextextended('vehicle-tours:'||tenant,0));
 IF EXISTS(SELECT 1 FROM vehicle_tours t WHERE t."companyId"=tenant AND t."teamId"=NEW."teamId" AND t.status IN ('PLANNED','IN_PROGRESS') AND NEW.date >= (t."startsAt" AT TIME ZONE tz)::date AND NEW.date <= ((t."endsAt" - interval '1 millisecond') AT TIME ZONE tz)::date AND NOT EXISTS(SELECT 1 FROM vehicle_tour_stops s WHERE s."tourId"=t.id AND s."worksiteId"=NEW."worksiteId")) THEN RAISE EXCEPTION 'DAILY_TEAM_PLANNING_CONFLICT' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM employee_assignments ea JOIN vehicle_tours t ON t."chauffeurId"=ea."employeeId" AND t."companyId"=tenant WHERE ea."assignmentId"=NEW.id AND t.status IN ('PLANNED','IN_PROGRESS') AND NEW.date >= (t."startsAt" AT TIME ZONE tz)::date AND NEW.date <= ((t."endsAt" - interval '1 millisecond') AT TIME ZONE tz)::date AND NOT EXISTS(SELECT 1 FROM vehicle_tour_stops s WHERE s."tourId"=t.id AND s."worksiteId"=NEW."worksiteId")) THEN RAISE EXCEPTION 'DAILY_DRIVER_PLANNING_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER vehicle_tours_team_planning_guard BEFORE INSERT OR UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION vehicle_tours_guard_team_planning();
CREATE FUNCTION vehicle_tours_guard_driver_planning() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant text; site text; tz text; BEGIN
 SELECT "companyId" INTO tenant FROM employees WHERE id=NEW."employeeId";
 SELECT "worksiteId" INTO site FROM assignments WHERE id=NEW."assignmentId";
 SELECT COALESCE((SELECT timezone FROM company_settings WHERE "companyId"=tenant),'Europe/Paris') INTO tz;
 PERFORM pg_advisory_xact_lock(hashtextextended('vehicle-tours:'||tenant,0));
 IF EXISTS(SELECT 1 FROM vehicle_tours t WHERE t."companyId"=tenant AND t."chauffeurId"=NEW."employeeId" AND t.status IN ('PLANNED','IN_PROGRESS') AND NEW.date >= (t."startsAt" AT TIME ZONE tz)::date AND NEW.date <= ((t."endsAt" - interval '1 millisecond') AT TIME ZONE tz)::date AND NOT EXISTS(SELECT 1 FROM vehicle_tour_stops s WHERE s."tourId"=t.id AND s."worksiteId"=site)) THEN RAISE EXCEPTION 'DAILY_DRIVER_PLANNING_CONFLICT' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER vehicle_tours_driver_planning_guard BEFORE INSERT OR UPDATE ON employee_assignments FOR EACH ROW EXECUTE FUNCTION vehicle_tours_guard_driver_planning();
-- Durable even after disabling V3: end of a linked V2 trip and completed tour
-- must commit together. Deferred because the caller updates both rows atomically.
CREATE FUNCTION vehicle_tours_trip_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM vehicle_tours t JOIN mileage_trips m ON m.id=t."mileageTripId" WHERE t."mileageTripId" IS NOT NULL AND ((t.status='COMPLETED' AND m."endEntryId" IS NULL) OR (t.status='IN_PROGRESS' AND m."endEntryId" IS NOT NULL))) THEN RAISE EXCEPTION 'TRIP_MANAGED_BY_TOUR' USING ERRCODE='23514', CONSTRAINT='vehicle_tours_trip_consistency_check'; END IF;
 RETURN NULL; END $$;
CREATE CONSTRAINT TRIGGER vehicle_tours_trip_consistency_on_trip AFTER UPDATE ON mileage_trips DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vehicle_tours_trip_consistency();
CREATE CONSTRAINT TRIGGER vehicle_tours_trip_consistency_on_tour AFTER INSERT OR UPDATE ON vehicle_tours DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vehicle_tours_trip_consistency();
-- Immediate refusal also propagates through Prisma 5 interactive commit behavior.
CREATE FUNCTION vehicle_tours_guard_trip_end() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked text; BEGIN
 SELECT id INTO linked FROM vehicle_tours WHERE "mileageTripId"=NEW.id;
 IF linked IS NOT NULL AND NEW."endEntryId" IS DISTINCT FROM OLD."endEntryId" AND current_setting('planificator.tour_completion',true) IS DISTINCT FROM linked THEN
 RAISE EXCEPTION 'TRIP_MANAGED_BY_TOUR' USING ERRCODE='23514', CONSTRAINT='vehicle_tours_trip_consistency_check'; END IF; RETURN NEW; END $$;
CREATE TRIGGER vehicle_tours_guard_trip_end BEFORE UPDATE OF "endEntryId" ON mileage_trips FOR EACH ROW EXECUTE FUNCTION vehicle_tours_guard_trip_end();
