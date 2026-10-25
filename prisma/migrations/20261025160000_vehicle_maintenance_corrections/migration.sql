BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE "vehicle_maintenance_entries" ADD COLUMN "supersedesEntryId" TEXT, ADD COLUMN "correctionReason" TEXT;
CREATE UNIQUE INDEX "vehicle_maintenance_entries_supersedesEntryId_key" ON "vehicle_maintenance_entries"("supersedesEntryId");
ALTER TABLE "vehicle_maintenance_entries" ADD CONSTRAINT "maintenance_correction_pair_check" CHECK (("supersedesEntryId" IS NULL AND "correctionReason" IS NULL) OR ("supersedesEntryId" IS NOT NULL AND "supersedesEntryId" <> "id" AND "correctionReason" IS NOT NULL AND char_length(btrim("correctionReason")) BETWEEN 1 AND 2000));
ALTER TABLE "vehicle_maintenance_entries" ADD CONSTRAINT "vehicle_maintenance_entries_supersedesEntryId_truckId_companyId_fkey" FOREIGN KEY ("supersedesEntryId", "truckId", "companyId") REFERENCES "vehicle_maintenance_entries"("id", "truckId", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Original rows remain immutable. Corrections append a new row and can only supersede one existing version.
COMMIT;
