-- Espace privé RH ↔ salarié : deux tables nouvelles, aucune table existante modifiée.
-- Indépendante de 20261103120000_hr_employee_drafts (toujours exclue de la production) : appliquer seule, après revue.

-- CreateTable
CREATE TABLE "hr_messages" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorSide" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "documentId" TEXT,
    "requestStatus" TEXT,
    "createKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "hr_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_document_accesses" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_document_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hr_messages_companyId_authorId_createKey_key" ON "hr_messages"("companyId", "authorId", "createKey");

-- CreateIndex
CREATE INDEX "hr_messages_companyId_employeeId_createdAt_idx" ON "hr_messages"("companyId", "employeeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "hr_document_accesses_documentId_version_userId_key" ON "hr_document_accesses"("documentId", "version", "userId");

-- CreateIndex
CREATE INDEX "hr_document_accesses_companyId_documentId_idx" ON "hr_document_accesses"("companyId", "documentId");

-- AddForeignKey
ALTER TABLE "hr_messages" ADD CONSTRAINT "hr_messages_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "employees"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_messages" ADD CONSTRAINT "hr_messages_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "hr_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_document_accesses" ADD CONSTRAINT "hr_document_accesses_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId") REFERENCES "hr_documents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
