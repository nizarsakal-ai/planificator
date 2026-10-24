-- Véhicule V2 : plans de vidange et journal d'entretien. Additif, aucune reprise de données.
-- Appliquer après vehicles_v2_mileage ; ne pas substituer db push aux migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "vehicle_maintenance_plans" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "truckId" TEXT NOT NULL,
  "intervalKm" INTEGER,
  "intervalMonths" INTEGER,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedById" TEXT NOT NULL,
  "updatedByNameSnapshot" TEXT NOT NULL,
  CONSTRAINT "vehicle_maintenance_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_plan_intervals_check" CHECK (
    ("intervalKm" IS NOT NULL OR "intervalMonths" IS NOT NULL)
    AND ("intervalKm" IS NULL OR "intervalKm" BETWEEN 1 AND 9999999)
    AND ("intervalMonths" IS NULL OR "intervalMonths" BETWEEN 1 AND 120)
    AND "revision" >= 1
  ),
  CONSTRAINT "vehicle_maintenance_plans_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "vehicle_maintenance_plans_truckId_companyId_fkey" FOREIGN KEY ("truckId", "companyId") REFERENCES "trucks"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "vehicle_maintenance_plans_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "vehicle_maintenance_plans_truckId_companyId_key" ON "vehicle_maintenance_plans"("truckId", "companyId");
CREATE INDEX "vehicle_maintenance_plans_companyId_idx" ON "vehicle_maintenance_plans"("companyId");

CREATE TABLE "vehicle_maintenance_entries" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "truckId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "mileage" INTEGER NOT NULL,
  "notes" TEXT,
  "createdById" TEXT NOT NULL,
  "createdByNameSnapshot" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  CONSTRAINT "vehicle_maintenance_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_entry_values_check" CHECK (
    "kind" IN ('OIL_CHANGE', 'SERVICE')
    AND "mileage" BETWEEN 0 AND 9999999
    AND ("notes" IS NULL OR char_length("notes") <= 2000)
    AND "requestHash" ~ '^[0-9a-f]{64}$'
    AND "idempotencyKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "vehicle_maintenance_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "vehicle_maintenance_entries_truckId_companyId_fkey" FOREIGN KEY ("truckId", "companyId") REFERENCES "trucks"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "vehicle_maintenance_entries_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "vehicle_maintenance_entries_companyId_truckId_idempotencyKey_key" ON "vehicle_maintenance_entries"("companyId", "truckId", "idempotencyKey");
CREATE INDEX "vehicle_maintenance_entries_companyId_truckId_occurredAt_idx" ON "vehicle_maintenance_entries"("companyId", "truckId", "occurredAt");

CREATE FUNCTION vehicle_maintenance_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VEHICLE_MAINTENANCE_IMMUTABLE: journal en ajout seul' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER vehicle_maintenance_entries_immutable
BEFORE UPDATE OR DELETE ON "vehicle_maintenance_entries"
FOR EACH ROW EXECUTE FUNCTION vehicle_maintenance_entries_immutable();

COMMIT;
