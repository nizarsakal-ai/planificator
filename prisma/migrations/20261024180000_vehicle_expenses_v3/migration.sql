-- CreateTable
CREATE TABLE "vehicle_expenses" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "litres" DECIMAL(12,3),
    "mileageObservation" INTEGER,
    "supplier" TEXT,
    "reference" TEXT,
    "receiptFingerprint" TEXT,
    "documentVersionId" TEXT,
    "maintenanceEntryId" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "sourceExpenseReportId" TEXT,
    "sourceSnapshot" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_expense_allocations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "mileageTripId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "vehicle_expense_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_expense_commands" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "vehicle_expense_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_expenses_companyId_truckId_occurredAt_idx" ON "vehicle_expenses"("companyId", "truckId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_expenses_id_truckId_companyId_key" ON "vehicle_expenses"("id", "truckId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_expenses_companyId_sourceExpenseReportId_key" ON "vehicle_expenses"("companyId", "sourceExpenseReportId");

-- CreateIndex
CREATE INDEX "vehicle_expense_allocations_companyId_truckId_expenseId_idx" ON "vehicle_expense_allocations"("companyId", "truckId", "expenseId");

-- CreateIndex
CREATE INDEX "vehicle_expense_commands_companyId_expenseId_recordedAt_idx" ON "vehicle_expense_commands"("companyId", "expenseId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_expense_commands_companyId_truckId_idempotencyKey_key" ON "vehicle_expense_commands"("companyId", "truckId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "mileage_trips_id_truck_company_key" ON "mileage_trips"("id", "truckId", "companyId");

-- AddForeignKey
ALTER TABLE "vehicle_expenses" ADD CONSTRAINT "vehicle_expenses_truckId_companyId_fkey" FOREIGN KEY ("truckId", "companyId") REFERENCES "trucks"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_expense_allocations" ADD CONSTRAINT "vehicle_expense_allocations_expenseId_truckId_companyId_fkey" FOREIGN KEY ("expenseId", "truckId", "companyId") REFERENCES "vehicle_expenses"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "vehicle_expense_commands" ADD CONSTRAINT "vehicle_expense_commands_expenseId_truckId_companyId_fkey" FOREIGN KEY ("expenseId", "truckId", "companyId") REFERENCES "vehicle_expenses"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Le lien note de frais est une provenance volontairement sans cascade/FK :
-- une source supprimée est conservée dans sourceSnapshot et exclue des indicateurs.
ALTER TABLE "vehicle_expenses" ADD CONSTRAINT "vehicle_expenses_values_check" CHECK (
  "amount" > 0 AND "amount" < 1000000000000 AND "currency" ~ '^[A-Z]{3}$'
  AND "category" IN ('FUEL', 'MAINTENANCE', 'INSURANCE', 'OTHER')
  AND "status" IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')
  AND "revision" > 0
  AND ("litres" IS NULL OR ("litres" > 0 AND "litres" < 1000000000 AND "category" = 'FUEL'))
  AND ("mileageObservation" IS NULL OR "mileageObservation" BETWEEN 0 AND 9999999)
  AND (("sourceExpenseReportId" IS NULL AND "sourceSnapshot" IS NULL) OR ("sourceExpenseReportId" IS NOT NULL AND "sourceSnapshot" IS NOT NULL))
);
CREATE UNIQUE INDEX "vehicle_expenses_receipt_company_key" ON "vehicle_expenses" ("companyId", "receiptFingerprint") WHERE "receiptFingerprint" IS NOT NULL;
ALTER TABLE "vehicle_expense_allocations" ADD CONSTRAINT "vehicle_expense_allocations_amount_check" CHECK ("amount" > 0 AND "amount" < 1000000000000);
ALTER TABLE "vehicle_expense_allocations" ADD CONSTRAINT "vehicle_expense_allocations_trip_scope_fkey" FOREIGN KEY ("mileageTripId", "truckId", "companyId") REFERENCES "mileage_trips" ("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "vehicle_expense_allocations_target_key" ON "vehicle_expense_allocations" ("expenseId", COALESCE("mileageTripId", ''));
-- Verrou parent pour sérialiser les allocations même quand elles viennent de SQL.
CREATE FUNCTION vehicle_expense_allocation_guard_v3() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_amount numeric; allocated numeric;
BEGIN
  SELECT "amount" INTO parent_amount FROM "vehicle_expenses" WHERE "id" = NEW."expenseId" AND "companyId" = NEW."companyId" AND "truckId" = NEW."truckId" FOR UPDATE;
  IF parent_amount IS NULL THEN RAISE EXCEPTION 'EXPENSE_NOT_FOUND'; END IF;
  SELECT COALESCE(SUM("amount"), 0) INTO allocated FROM "vehicle_expense_allocations" WHERE "expenseId" = NEW."expenseId" AND "id" <> NEW."id";
  IF allocated + NEW."amount" > parent_amount THEN RAISE EXCEPTION 'OVER_ALLOCATION'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vehicle_expense_allocation_guard_v3 BEFORE INSERT OR UPDATE ON "vehicle_expense_allocations" FOR EACH ROW EXECUTE FUNCTION vehicle_expense_allocation_guard_v3();
CREATE FUNCTION vehicle_expense_amount_guard_v3() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."amount" < (SELECT COALESCE(SUM("amount"), 0) FROM "vehicle_expense_allocations" WHERE "expenseId" = NEW."id") THEN RAISE EXCEPTION 'OVER_ALLOCATION'; END IF;
  IF NEW."currency" <> OLD."currency" AND EXISTS (SELECT 1 FROM "vehicle_expense_allocations" WHERE "expenseId" = NEW."id") THEN RAISE EXCEPTION 'ALLOCATIONS_CURRENCY_CONFLICT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vehicle_expense_amount_guard_v3 BEFORE UPDATE ON "vehicle_expenses" FOR EACH ROW EXECUTE FUNCTION vehicle_expense_amount_guard_v3();
CREATE FUNCTION vehicle_expense_audit_immutable_v3() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'EXPENSE_AUDIT_IMMUTABLE'; END $$;
CREATE TRIGGER vehicle_expense_audit_immutable_v3 BEFORE UPDATE OR DELETE ON "vehicle_expense_commands" FOR EACH ROW EXECUTE FUNCTION vehicle_expense_audit_immutable_v3();
CREATE TRIGGER vehicle_expense_no_delete_v3 BEFORE DELETE ON "vehicle_expenses" FOR EACH ROW EXECUTE FUNCTION vehicle_expense_audit_immutable_v3();

ALTER TABLE "vehicle_expense_commands" ADD CONSTRAINT "vehicle_expense_commands_action_check" CHECK (
  "action" IN ('CREATE','CORRECT','APPROVE','REJECT','CANCEL','RECONCILE','ALLOCATE')
  AND ("action" = 'CREATE' OR length(trim("reason")) >= 3 AND "reason" IS NOT NULL)
);
ALTER TABLE "vehicle_expenses" ADD CONSTRAINT "vehicle_expenses_fingerprint_check" CHECK ("receiptFingerprint" IS NULL OR "receiptFingerprint" ~ '^[a-f0-9]{64}$');
