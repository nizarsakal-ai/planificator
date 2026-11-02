-- CreateTable
CREATE TABLE "hr_document_stores" (
    "companyId" TEXT NOT NULL,
    "rootId" TEXT NOT NULL,
    "connectionGeneration" TEXT NOT NULL,
    "accountEmail" TEXT NOT NULL,

    CONSTRAINT "hr_document_stores_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "hr_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "rootId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadKey" TEXT NOT NULL,
    "uploadIntent" TEXT NOT NULL,
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "hr_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_document_events" (
    "driveFileId" TEXT,
    "sha256" TEXT,
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_document_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_document_receipts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_document_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_document_notices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "publishedVersion" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "hr_document_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_document_store_events" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hr_document_store_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "hr_document_stores_rootId_key" ON "hr_document_stores"("rootId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_documents_driveFileId_key" ON "hr_documents"("driveFileId");

-- CreateIndex
CREATE INDEX "hr_documents_companyId_status_id_idx" ON "hr_documents"("companyId", "status", "id");

-- CreateIndex
CREATE INDEX "hr_documents_companyId_employeeId_status_id_idx" ON "hr_documents"("companyId", "employeeId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "hr_documents_id_companyId_key" ON "hr_documents"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_documents_companyId_uploadedById_uploadKey_key" ON "hr_documents"("companyId", "uploadedById", "uploadKey");

-- CreateIndex
CREATE UNIQUE INDEX "hr_documents_companyId_employeeId_category_period_sha256_key" ON "hr_documents"("companyId", "employeeId", "category", "period", "sha256");

-- CreateIndex
CREATE INDEX "hr_document_events_companyId_documentId_idx" ON "hr_document_events"("companyId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "hr_document_events_documentId_version_key" ON "hr_document_events"("documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "hr_document_receipts_companyId_actorId_key_key" ON "hr_document_receipts"("companyId", "actorId", "key");

-- CreateIndex
CREATE INDEX "hr_document_notices_companyId_status_idx" ON "hr_document_notices"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hr_document_notices_documentId_publishedVersion_key" ON "hr_document_notices"("documentId", "publishedVersion");

-- CreateIndex
CREATE INDEX "hr_document_store_events_companyId_createdAt_idx" ON "hr_document_store_events"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "hr_document_stores" ADD CONSTRAINT "hr_document_stores_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_documents" ADD CONSTRAINT "hr_documents_employeeId_companyId_fkey" FOREIGN KEY ("employeeId", "companyId") REFERENCES "employees"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_document_events" ADD CONSTRAINT "hr_document_events_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId") REFERENCES "hr_documents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_document_receipts" ADD CONSTRAINT "hr_document_receipts_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId") REFERENCES "hr_documents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_document_notices" ADD CONSTRAINT "hr_document_notices_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId") REFERENCES "hr_documents"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_document_store_events" ADD CONSTRAINT "hr_document_store_events_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "hr_document_stores"("companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
