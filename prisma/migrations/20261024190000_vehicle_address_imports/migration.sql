CREATE TABLE "vehicle_address_imports" (
 "id" TEXT PRIMARY KEY, "companyId" TEXT NOT NULL, "truckId" TEXT NOT NULL,
 "createdById" TEXT NOT NULL, "filename" TEXT NOT NULL, "mime" TEXT NOT NULL,
 "sourceHash" TEXT NOT NULL, "storageId" TEXT NOT NULL UNIQUE,
 "revision" INTEGER NOT NULL DEFAULT 0, "candidates" JSONB NOT NULL, "warnings" JSONB NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'DRAFT', "reviewedById" TEXT, "reviewedAt" TIMESTAMP(3),
 "consumptionKey" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "vehicle_address_imports_truckId_companyId_fkey" FOREIGN KEY ("truckId","companyId") REFERENCES "trucks"("id","companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "vehicle_address_imports_bounds" CHECK ("revision" BETWEEN 0 AND 10000 AND jsonb_typeof("candidates")='array' AND jsonb_array_length("candidates")<=40 AND octet_length("candidates"::text)<=100000),
 CONSTRAINT "vehicle_address_imports_status" CHECK ("status" IN ('PROCESSING','FAILED','DRAFT','APPROVED','CONSUMED')),
 CONSTRAINT "vehicle_address_imports_review" CHECK (("status" NOT IN ('APPROVED','CONSUMED')) OR ("reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL)),
 CONSTRAINT "vehicle_address_imports_consumption" CHECK (("status"='CONSUMED')=("consumptionKey" IS NOT NULL))
);
CREATE INDEX "vehicle_address_imports_companyId_truckId_createdAt_idx" ON "vehicle_address_imports"("companyId","truckId","createdAt");
CREATE INDEX "vehicle_address_imports_companyId_createdAt_idx" ON "vehicle_address_imports"("companyId","createdAt");
CREATE TABLE "vehicle_import_provider_windows" (
 "companyId" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE RESTRICT,
 "provider" TEXT NOT NULL CHECK ("provider" IN ('ROUTING','GEOCODING')),
 "windowStart" TIMESTAMP(3) NOT NULL, "count" INTEGER NOT NULL CHECK ("count" BETWEEN 1 AND 60),
 PRIMARY KEY ("companyId","provider","windowStart")
);
