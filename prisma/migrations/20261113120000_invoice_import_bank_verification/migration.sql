-- SPEC-INVOICE-IMPORT-001 + SPEC-BANK-VERIF-001 — migration ADDITIVE (nouvelles tables/enums uniquement, aucune table existante modifiée).
-- Compatible avec l'application précédente ; retour arrière applicatif possible sans toucher aux données.
CREATE TYPE "ImportedDocumentKind" AS ENUM ('INVOICE', 'CREDIT_NOTE');
CREATE TYPE "ImportedDocumentStatus" AS ENUM ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED', 'UNKNOWN');
CREATE TYPE "InvoiceImportBatchStatus" AS ENUM ('PREVIEW', 'COMMITTED', 'CANCELLED');
CREATE TYPE "BankAccountVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED');
CREATE TYPE "BankVerificationSessionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED');
CREATE TABLE "imported_document_files" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "originalName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imported_document_files_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "invoice_import_batches" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceLabel" TEXT,
    "status" "InvoiceImportBatchStatus" NOT NULL DEFAULT 'PREVIEW',
    "headerSignature" TEXT,
    "mapping" JSONB,
    "rows" JSONB NOT NULL,
    "summary" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "committedById" TEXT,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_import_batches_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "imported_invoices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "kind" "ImportedDocumentKind" NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceReference" TEXT,
    "sourceStatus" TEXT,
    "status" "ImportedDocumentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "number" TEXT NOT NULL,
    "numberKey" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "worksiteId" TEXT,
    "issueDate" DATE NOT NULL,
    "dueDate" DATE,
    "totalHTCents" BIGINT NOT NULL,
    "vatCents" BIGINT NOT NULL,
    "totalTTCCents" BIGINT NOT NULL,
    "creditedNumber" TEXT,
    "creditedImportedInvoiceId" TEXT,
    "creditedInvoiceId" TEXT,
    "fileId" TEXT,
    "contentHash" TEXT NOT NULL,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "imported_invoices_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "company_bank_accounts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "status" "BankAccountVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "provider" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedHolderName" TEXT,
    "failureCode" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_bank_accounts_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "bank_verification_sessions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "stateHash" TEXT NOT NULL,
    "iban" TEXT NOT NULL,
    "status" "BankVerificationSessionStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "result" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_verification_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "imported_document_files_companyId_id_key" ON "imported_document_files"("companyId", "id");
CREATE UNIQUE INDEX "imported_document_files_companyId_sha256_key" ON "imported_document_files"("companyId", "sha256");
CREATE INDEX "invoice_import_batches_companyId_status_idx" ON "invoice_import_batches"("companyId", "status");
CREATE INDEX "invoice_import_batches_companyId_sourceSystem_headerSignatu_idx" ON "invoice_import_batches"("companyId", "sourceSystem", "headerSignature");
CREATE UNIQUE INDEX "invoice_import_batches_companyId_id_key" ON "invoice_import_batches"("companyId", "id");
CREATE INDEX "imported_invoices_companyId_clientId_idx" ON "imported_invoices"("companyId", "clientId");
CREATE INDEX "imported_invoices_companyId_issueDate_idx" ON "imported_invoices"("companyId", "issueDate");
CREATE INDEX "imported_invoices_worksiteId_idx" ON "imported_invoices"("worksiteId");
CREATE UNIQUE INDEX "imported_invoices_companyId_id_key" ON "imported_invoices"("companyId", "id");
CREATE UNIQUE INDEX "imported_invoices_companyId_kind_numberKey_key" ON "imported_invoices"("companyId", "kind", "numberKey");
CREATE UNIQUE INDEX "company_bank_accounts_companyId_key" ON "company_bank_accounts"("companyId");
CREATE UNIQUE INDEX "company_bank_accounts_companyId_id_key" ON "company_bank_accounts"("companyId", "id");
CREATE UNIQUE INDEX "bank_verification_sessions_stateHash_key" ON "bank_verification_sessions"("stateHash");
CREATE INDEX "bank_verification_sessions_companyId_accountId_idx" ON "bank_verification_sessions"("companyId", "accountId");
ALTER TABLE "imported_document_files" ADD CONSTRAINT "imported_document_files_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_import_batches" ADD CONSTRAINT "invoice_import_batches_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "imported_invoices" ADD CONSTRAINT "imported_invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "imported_invoices" ADD CONSTRAINT "imported_invoices_companyId_batchId_fkey" FOREIGN KEY ("companyId", "batchId") REFERENCES "invoice_import_batches"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "imported_invoices" ADD CONSTRAINT "imported_invoices_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "imported_invoices" ADD CONSTRAINT "imported_invoices_worksiteId_fkey" FOREIGN KEY ("worksiteId") REFERENCES "worksites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "imported_invoices" ADD CONSTRAINT "imported_invoices_companyId_fileId_fkey" FOREIGN KEY ("companyId", "fileId") REFERENCES "imported_document_files"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "imported_invoices" ADD CONSTRAINT "imported_invoices_companyId_creditedImportedInvoiceId_fkey" FOREIGN KEY ("companyId", "creditedImportedInvoiceId") REFERENCES "imported_invoices"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "imported_invoices" ADD CONSTRAINT "imported_invoices_creditedInvoiceId_companyId_fkey" FOREIGN KEY ("creditedInvoiceId", "companyId") REFERENCES "invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_bank_accounts" ADD CONSTRAINT "company_bank_accounts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_verification_sessions" ADD CONSTRAINT "bank_verification_sessions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "bank_verification_sessions" ADD CONSTRAINT "bank_verification_sessions_companyId_accountId_fkey" FOREIGN KEY ("companyId", "accountId") REFERENCES "company_bank_accounts"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Filets en base (au-delà de Prisma) --------------------------------------------------------------------------
-- Montants cohérents et positifs (un avoir est stocké en valeur absolue, sa nature est portée par "kind").
ALTER TABLE "imported_invoices" ADD CONSTRAINT "imported_invoices_amounts_check"
  CHECK ("totalHTCents" >= 0 AND "vatCents" >= 0 AND "totalTTCCents" > 0 AND "totalHTCents" + "vatCents" = "totalTTCCents");
-- Un avoir peut référencer une facture d'origine (importée OU Planificator, jamais les deux) ; une facture n'en référence aucune.
ALTER TABLE "imported_invoices" ADD CONSTRAINT "imported_invoices_credit_link_check"
  CHECK (("kind" = 'CREDIT_NOTE' OR ("creditedImportedInvoiceId" IS NULL AND "creditedInvoiceId" IS NULL))
     AND NOT ("creditedImportedInvoiceId" IS NOT NULL AND "creditedInvoiceId" IS NOT NULL));
-- "VERIFIED" exige la trace de la confirmation du prestataire.
ALTER TABLE "company_bank_accounts" ADD CONSTRAINT "company_bank_accounts_verified_check"
  CHECK ("status" <> 'VERIFIED' OR ("verifiedAt" IS NOT NULL AND "provider" IS NOT NULL));
ALTER TABLE "company_bank_accounts" ADD CONSTRAINT "company_bank_accounts_iban_format_check"
  CHECK ("iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$');
-- Une seule session de vérification EN COURS par compte.
CREATE UNIQUE INDEX "bank_verification_sessions_one_pending_per_account"
  ON "bank_verification_sessions" ("accountId") WHERE "status" = 'PENDING';
