-- Lot C5 — Comptabilité : lien pièce ↔ écriture, fournisseurs, factures fournisseurs (fichiers en base), relevés et opérations
-- bancaires, déclarations de TVA. Migration ADDITIVE (nouvelles tables, FK composites société, onDelete Restrict).

-- CreateEnum
CREATE TYPE "SupplierInvoiceStatus" AS ENUM ('PENDING', 'VALIDATED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BankTransactionStatus" AS ENUM ('PENDING', 'MATCHED', 'IGNORED');

-- CreateEnum
CREATE TYPE "VatDeclarationStatus" AS ENUM ('DRAFT', 'DECLARED');

-- CreateTable
CREATE TABLE "accounting_document_postings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "entryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_document_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "siret" TEXT,
    "vatNumber" TEXT,
    "email" TEXT,
    "address" TEXT,
    "defaultExpenseAccountId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_files" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "originalName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_invoice_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoices" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierName" TEXT NOT NULL,
    "siret" TEXT,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "dueDate" DATE,
    "totalHTCents" BIGINT NOT NULL,
    "vatCents" BIGINT NOT NULL,
    "totalTTCCents" BIGINT NOT NULL,
    "vatRateBp" INTEGER,
    "category" TEXT,
    "expenseAccountId" TEXT,
    "status" "SupplierInvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "fileId" TEXT,
    "ocrProvider" TEXT,
    "ocrRaw" JSONB,
    "ocrConfidence" JSONB,
    "validatedAt" TIMESTAMP(3),
    "validatedById" TEXT,
    "paidAt" DATE,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_imports" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "mapping" JSONB NOT NULL,
    "importedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transactions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "reference" TEXT,
    "fingerprint" TEXT NOT NULL,
    "status" "BankTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "matchedInvoiceId" TEXT,
    "matchedPaymentId" TEXT,
    "matchedSupplierInvoiceId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_declarations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "basis" "VatRegime" NOT NULL,
    "collectedCents" BIGINT NOT NULL,
    "deductibleCents" BIGINT NOT NULL,
    "dueCents" BIGINT NOT NULL,
    "details" JSONB NOT NULL,
    "status" "VatDeclarationStatus" NOT NULL DEFAULT 'DECLARED',
    "declaredAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vat_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounting_document_postings_companyId_entryId_idx" ON "accounting_document_postings"("companyId", "entryId");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_document_postings_companyId_sourceType_sourceId__key" ON "accounting_document_postings"("companyId", "sourceType", "sourceId", "sourceVersion");

-- CreateIndex
CREATE INDEX "suppliers_companyId_name_idx" ON "suppliers"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_companyId_siret_key" ON "suppliers"("companyId", "siret");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoice_files_companyId_sha256_key" ON "supplier_invoice_files"("companyId", "sha256");

-- CreateIndex
CREATE INDEX "supplier_invoices_companyId_status_idx" ON "supplier_invoices"("companyId", "status");

-- CreateIndex
CREATE INDEX "supplier_invoices_companyId_date_idx" ON "supplier_invoices"("companyId", "date");

-- CreateIndex
CREATE INDEX "supplier_invoices_companyId_supplierId_idx" ON "supplier_invoices"("companyId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_imports_companyId_sha256_key" ON "bank_statement_imports"("companyId", "sha256");

-- CreateIndex
CREATE INDEX "bank_transactions_companyId_status_idx" ON "bank_transactions"("companyId", "status");

-- CreateIndex
CREATE INDEX "bank_transactions_companyId_date_idx" ON "bank_transactions"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_companyId_fingerprint_key" ON "bank_transactions"("companyId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transactions_matchedPaymentId_key" ON "bank_transactions"("matchedPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "vat_declarations_companyId_periodStart_periodEnd_key" ON "vat_declarations"("companyId", "periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "accounting_document_postings" ADD CONSTRAINT "accounting_document_postings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_document_postings" ADD CONSTRAINT "accounting_document_postings_companyId_entryId_fkey" FOREIGN KEY ("companyId", "entryId") REFERENCES "journal_entries"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_companyId_defaultExpenseAccountId_fkey" FOREIGN KEY ("companyId", "defaultExpenseAccountId") REFERENCES "accounting_accounts"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_files" ADD CONSTRAINT "supplier_invoice_files_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_companyId_expenseAccountId_fkey" FOREIGN KEY ("companyId", "expenseAccountId") REFERENCES "accounting_accounts"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "supplier_invoice_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_imports" ADD CONSTRAINT "bank_statement_imports_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_importId_fkey" FOREIGN KEY ("importId") REFERENCES "bank_statement_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_companyId_matchedInvoiceId_fkey" FOREIGN KEY ("companyId", "matchedInvoiceId") REFERENCES "invoices"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_matchedPaymentId_fkey" FOREIGN KEY ("matchedPaymentId") REFERENCES "invoice_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_matchedSupplierInvoiceId_fkey" FOREIGN KEY ("matchedSupplierInvoiceId") REFERENCES "supplier_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vat_declarations" ADD CONSTRAINT "vat_declarations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
