-- CreateTable
CREATE TABLE "trucks" (
    "id" TEXT NOT NULL,
    "matricule" TEXT NOT NULL,
    "marque" TEXT,
    "companyId" TEXT NOT NULL,
    "teamId" TEXT,
    "chauffeurId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trucks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "truck_assignments" (
    "id" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "chauffeurId" TEXT,
    "teamId" TEXT,
    "companyId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "truck_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trucks_teamId_key" ON "trucks"("teamId");

-- CreateIndex
CREATE INDEX "trucks_companyId_idx" ON "trucks"("companyId");

-- CreateIndex
CREATE INDEX "trucks_chauffeurId_idx" ON "trucks"("chauffeurId");

-- CreateIndex
CREATE UNIQUE INDEX "trucks_matricule_companyId_key" ON "trucks"("matricule", "companyId");

-- CreateIndex
CREATE INDEX "truck_assignments_truckId_startedAt_idx" ON "truck_assignments"("truckId", "startedAt");

-- CreateIndex
CREATE INDEX "truck_assignments_chauffeurId_idx" ON "truck_assignments"("chauffeurId");

-- CreateIndex
CREATE INDEX "truck_assignments_companyId_idx" ON "truck_assignments"("companyId");

-- AddForeignKey
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trucks" ADD CONSTRAINT "trucks_chauffeurId_fkey" FOREIGN KEY ("chauffeurId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_assignments" ADD CONSTRAINT "truck_assignments_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "trucks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_assignments" ADD CONSTRAINT "truck_assignments_chauffeurId_fkey" FOREIGN KEY ("chauffeurId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_assignments" ADD CONSTRAINT "truck_assignments_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
