-- Lot B Planificator V2 (04/11/2026) : matériel et location (équipements, réservations, contrats de location, entretiens).
-- Migration EXPAND, purement additive : 5 types, 4 tables, leurs index et clés. Aucune table existante modifiée,
-- aucune ligne existante lue ni écrite. Corps généré par `prisma migrate diff` (schéma lot A vers ce lot), puis
-- contraintes CHECK de défense en profondeur ajoutées à la main (fin de fichier). Module désactivé par défaut
-- (EQUIPMENT_RENTAL_ENABLED). Dépend de la migration du lot A (table "warehouses").

BEGIN;

CREATE TYPE "EquipmentStatus" AS ENUM ('AVAILABLE', 'OUT', 'MAINTENANCE', 'RETIRED');

CREATE TYPE "EquipmentCondition" AS ENUM ('GOOD', 'WORN', 'DAMAGED');

CREATE TYPE "EquipmentOwnership" AS ENUM ('OWNED', 'RENTED');

CREATE TYPE "EquipmentBookingStatus" AS ENUM ('RESERVED', 'CHECKED_OUT', 'RETURNED', 'CANCELLED');

CREATE TYPE "EquipmentRentalStatus" AS ENUM ('ACTIVE', 'CLOSED', 'CANCELLED');

CREATE TABLE "equipment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "serialNumber" TEXT,
    "ownership" "EquipmentOwnership" NOT NULL DEFAULT 'OWNED',
    "status" "EquipmentStatus" NOT NULL DEFAULT 'AVAILABLE',
    "condition" "EquipmentCondition" NOT NULL DEFAULT 'GOOD',
    "warehouseId" TEXT,
    "dailyCostCents" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "equipment_bookings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "worksiteId" TEXT,
    "responsibleEmployeeId" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "EquipmentBookingStatus" NOT NULL DEFAULT 'RESERVED',
    "depositCents" INTEGER,
    "checkedOutAt" TIMESTAMP(3),
    "checkoutCondition" "EquipmentCondition",
    "returnedAt" TIMESTAMP(3),
    "returnCondition" "EquipmentCondition",
    "returnNotes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_bookings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "equipment_rental_contracts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "worksiteId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "dailyRateCents" INTEGER NOT NULL,
    "fixedFeesCents" INTEGER NOT NULL DEFAULT 0,
    "status" "EquipmentRentalStatus" NOT NULL DEFAULT 'ACTIVE',
    "returnedOn" DATE,
    "costCents" BIGINT,
    "supplierInvoiceId" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_rental_contracts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "equipment_maintenances" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "plannedOn" DATE,
    "performedOn" DATE,
    "costCents" INTEGER,
    "supplierId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_maintenances_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "equipment_companyId_status_idx" ON "equipment"("companyId", "status");

CREATE UNIQUE INDEX "equipment_companyId_id_key" ON "equipment"("companyId", "id");

CREATE UNIQUE INDEX "equipment_companyId_number_key" ON "equipment"("companyId", "number");

CREATE INDEX "equipment_bookings_companyId_equipmentId_startAt_idx" ON "equipment_bookings"("companyId", "equipmentId", "startAt");

CREATE INDEX "equipment_bookings_companyId_worksiteId_idx" ON "equipment_bookings"("companyId", "worksiteId");

CREATE INDEX "equipment_bookings_companyId_status_idx" ON "equipment_bookings"("companyId", "status");

CREATE INDEX "equipment_rental_contracts_companyId_equipmentId_idx" ON "equipment_rental_contracts"("companyId", "equipmentId");

CREATE INDEX "equipment_rental_contracts_companyId_worksiteId_idx" ON "equipment_rental_contracts"("companyId", "worksiteId");

CREATE UNIQUE INDEX "equipment_rental_contracts_companyId_number_key" ON "equipment_rental_contracts"("companyId", "number");

CREATE INDEX "equipment_maintenances_companyId_equipmentId_idx" ON "equipment_maintenances"("companyId", "equipmentId");

ALTER TABLE "equipment" ADD CONSTRAINT "equipment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment" ADD CONSTRAINT "equipment_companyId_warehouseId_fkey" FOREIGN KEY ("companyId", "warehouseId") REFERENCES "warehouses"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_bookings" ADD CONSTRAINT "equipment_bookings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_bookings" ADD CONSTRAINT "equipment_bookings_companyId_equipmentId_fkey" FOREIGN KEY ("companyId", "equipmentId") REFERENCES "equipment"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_bookings" ADD CONSTRAINT "equipment_bookings_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_bookings" ADD CONSTRAINT "equipment_bookings_responsibleEmployeeId_companyId_fkey" FOREIGN KEY ("responsibleEmployeeId", "companyId") REFERENCES "employees"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_rental_contracts" ADD CONSTRAINT "equipment_rental_contracts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_rental_contracts" ADD CONSTRAINT "equipment_rental_contracts_companyId_equipmentId_fkey" FOREIGN KEY ("companyId", "equipmentId") REFERENCES "equipment"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_rental_contracts" ADD CONSTRAINT "equipment_rental_contracts_companyId_supplierId_fkey" FOREIGN KEY ("companyId", "supplierId") REFERENCES "suppliers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_rental_contracts" ADD CONSTRAINT "equipment_rental_contracts_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_rental_contracts" ADD CONSTRAINT "equipment_rental_contracts_companyId_supplierInvoiceId_fkey" FOREIGN KEY ("companyId", "supplierInvoiceId") REFERENCES "supplier_invoices"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_maintenances" ADD CONSTRAINT "equipment_maintenances_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_maintenances" ADD CONSTRAINT "equipment_maintenances_companyId_equipmentId_fkey" FOREIGN KEY ("companyId", "equipmentId") REFERENCES "equipment"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_maintenances" ADD CONSTRAINT "equipment_maintenances_companyId_supplierId_fkey" FOREIGN KEY ("companyId", "supplierId") REFERENCES "suppliers"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Défense en profondeur (le service applique les mêmes règles avant d'écrire).
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_values_check" CHECK (
  length(btrim("number")) BETWEEN 1 AND 40 AND "number" = btrim("number")
  AND length(btrim("name")) BETWEEN 1 AND 160 AND "name" = btrim("name")
  AND length(btrim("category")) BETWEEN 1 AND 80
  AND ("serialNumber" IS NULL OR length("serialNumber") <= 120)
  AND ("dailyCostCents" IS NULL OR "dailyCostCents" >= 0)
  AND ("notes" IS NULL OR length("notes") <= 2000)
);
-- Période non vide ; état cohérent avec le statut (sortie ⇒ date et état de sortie ; retour ⇒ date et état de retour
-- postérieurs à la sortie ; réservée ou annulée ⇒ ni sortie ni retour).
ALTER TABLE "equipment_bookings" ADD CONSTRAINT "equipment_bookings_values_check" CHECK (
  "endAt" > "startAt"
  AND ("depositCents" IS NULL OR "depositCents" >= 0)
  AND length(btrim("createdById")) > 0
  AND ("returnNotes" IS NULL OR length("returnNotes") <= 1000)
  AND (
    ("status" IN ('RESERVED', 'CANCELLED') AND "checkedOutAt" IS NULL AND "checkoutCondition" IS NULL
      AND "returnedAt" IS NULL AND "returnCondition" IS NULL)
    OR ("status" = 'CHECKED_OUT' AND "checkedOutAt" IS NOT NULL AND "checkoutCondition" IS NOT NULL
      AND "returnedAt" IS NULL AND "returnCondition" IS NULL)
    OR ("status" = 'RETURNED' AND "checkedOutAt" IS NOT NULL AND "checkoutCondition" IS NOT NULL
      AND "returnedAt" IS NOT NULL AND "returnCondition" IS NOT NULL AND "returnedAt" >= "checkedOutAt")
  )
);
-- Contrat : période valide ; coût figé seulement à la clôture (date de retour comprise dans [début, …]).
ALTER TABLE "equipment_rental_contracts" ADD CONSTRAINT "equipment_rental_contracts_values_check" CHECK (
  "endDate" >= "startDate" AND "dailyRateCents" >= 0 AND "fixedFeesCents" >= 0
  AND length(btrim("number")) > 0 AND length(btrim("createdById")) > 0
  AND ("notes" IS NULL OR length("notes") <= 2000)
  AND (
    ("status" = 'ACTIVE' AND "returnedOn" IS NULL AND "costCents" IS NULL)
    OR ("status" = 'CANCELLED' AND "returnedOn" IS NULL AND "costCents" IS NULL)
    OR ("status" = 'CLOSED' AND "returnedOn" IS NOT NULL AND "returnedOn" >= "startDate"
      AND "costCents" IS NOT NULL AND "costCents" >= 0)
  )
);
ALTER TABLE "equipment_maintenances" ADD CONSTRAINT "equipment_maintenances_values_check" CHECK (
  length(btrim("description")) BETWEEN 1 AND 500
  AND ("costCents" IS NULL OR "costCents" >= 0)
  AND ("plannedOn" IS NOT NULL OR "performedOn" IS NOT NULL)
  AND length(btrim("createdById")) > 0
);

COMMIT;
