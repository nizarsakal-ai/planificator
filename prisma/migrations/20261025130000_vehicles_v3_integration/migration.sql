-- Bridges between independently reviewed V3 lots. Additive, no data backfill.
ALTER TYPE "VehicleDocumentCategory" ADD VALUE IF NOT EXISTS 'EXPENSE_RECEIPT';

BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE UNIQUE INDEX "vehicle_document_versions_id_truck_company_key"
  ON "vehicle_document_versions" ("id", "truckId", "companyId");
ALTER TABLE "vehicle_expenses"
  ADD CONSTRAINT "vehicle_expenses_document_scope_fkey"
  FOREIGN KEY ("documentVersionId", "truckId", "companyId")
  REFERENCES "vehicle_document_versions" ("id", "truckId", "companyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "vehicle_expenses"
  ADD CONSTRAINT "vehicle_expenses_maintenance_scope_fkey"
  FOREIGN KEY ("maintenanceEntryId", "truckId", "companyId")
  REFERENCES "vehicle_maintenance_entries" ("id", "truckId", "companyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
COMMIT;
