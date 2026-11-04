-- PLV2-DOC-RH-002 — fiches à compléter créées depuis une pièce d'identité.
-- Additive uniquement : nouvelle table, aucune colonne ni contrainte modifiée sur employees, users ou hr_documents.
-- Préparée et testée sur une base PostgreSQL jetable locale. NON appliquée en production (mandat séparé requis).

-- CreateTable
CREATE TABLE "hr_employee_drafts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createKey" TEXT NOT NULL,
    "birthDate" DATE,
    "sex" TEXT,
    "nationality" TEXT,
    "identityExpiry" DATE,
    "documentNumberEnd" TEXT,
    "sourceSha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_employee_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hr_employee_drafts_employeeId_key" ON "hr_employee_drafts"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_employee_drafts_employeeId_companyId_key" ON "hr_employee_drafts"("employeeId", "companyId");

-- CreateIndex
CREATE INDEX "hr_employee_drafts_companyId_status_idx" ON "hr_employee_drafts"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hr_employee_drafts_companyId_createdById_createKey_key" ON "hr_employee_drafts"("companyId", "createdById", "createKey");

-- AddForeignKey
ALTER TABLE "hr_employee_drafts" ADD CONSTRAINT "hr_employee_drafts_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "employees"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
