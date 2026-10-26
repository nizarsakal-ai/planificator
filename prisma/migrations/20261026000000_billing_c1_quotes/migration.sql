-- Lot C1 — Devis complets (SPEC-BILLING-C1). Migration ADDITIVE : aucune suppression ni renommage de colonne
-- utilisée en production ; toutes les colonnes ajoutées sont facultatives ou ont un défaut.
-- (La dérive préexistante détectée par « prisma migrate diff » sur les tables véhicules/acquisition est hors périmètre et n'est pas touchée.)

-- CreateEnum
CREATE TYPE "VatRegime" AS ENUM ('DEBITS', 'ENCAISSEMENTS');

-- CreateEnum
CREATE TYPE "BillingMailStatus" AS ENUM ('SIMULATED', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "QuoteStatus" ADD VALUE 'CONVERTED';

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "siret" TEXT,
ADD COLUMN     "vatNumber" TEXT;

-- AlterTable
ALTER TABLE "invoice_lines" ADD COLUMN     "description" TEXT,
ADD COLUMN     "discountBp" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "globalDiscountBp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "vatReverseCharge" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "quote_lines" ADD COLUMN     "description" TEXT,
ADD COLUMN     "discountBp" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "convertedAt" TIMESTAMP(3),
ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "globalDiscountBp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "importRef" TEXT,
ADD COLUMN     "refusalReason" TEXT,
ADD COLUMN     "refusedAt" TIMESTAMP(3),
ADD COLUMN     "reminderJ15SentAt" TIMESTAMP(3),
ADD COLUMN     "reminderJ3SentAt" TIMESTAMP(3),
ADD COLUMN     "reminderJ7SentAt" TIMESTAMP(3),
ADD COLUMN     "signatureIpHash" TEXT,
ADD COLUMN     "signatureTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "signatureTokenHash" TEXT,
ADD COLUMN     "signedAt" TIMESTAMP(3),
ADD COLUMN     "signerName" TEXT,
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "vatReverseCharge" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "billing_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vatNumber" TEXT,
    "legalForm" TEXT,
    "shareCapital" TEXT,
    "rcs" TEXT,
    "iban" TEXT,
    "bic" TEXT,
    "quoteValidityDays" INTEGER NOT NULL DEFAULT 30,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "latePenaltyText" TEXT,
    "quoteFooter" TEXT,
    "invoiceFooter" TEXT,
    "vatRegime" "VatRegime" NOT NULL DEFAULT 'DEBITS',
    "defaultDepositBp" INTEGER NOT NULL DEFAULT 3000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_mail_logs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" "BillingMailStatus" NOT NULL,
    "providerId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_mail_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_settings_companyId_key" ON "billing_settings"("companyId");

-- CreateIndex
CREATE INDEX "billing_mail_logs_companyId_documentType_documentId_idx" ON "billing_mail_logs"("companyId", "documentType", "documentId");

-- CreateIndex
CREATE INDEX "billing_mail_logs_companyId_createdAt_idx" ON "billing_mail_logs"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_signatureTokenHash_key" ON "quotes"("signatureTokenHash");

-- CreateIndex
CREATE INDEX "quotes_companyId_status_idx" ON "quotes"("companyId", "status");

-- CreateIndex
CREATE INDEX "quotes_companyId_issueDate_idx" ON "quotes"("companyId", "issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_id_companyId_key" ON "quotes"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_companyId_importRef_key" ON "quotes"("companyId", "importRef");

-- AddForeignKey
ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_mail_logs" ADD CONSTRAINT "billing_mail_logs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Lot C1 : l'avoir total (Lot B) reste une copie exacte — la comparaison intègre les nouvelles colonnes
-- (remise globale, autoliquidation, description et remise de ligne). Même signature, même sémantique.
CREATE OR REPLACE FUNCTION invoice_credit_matches(note_id text, orig_id text) RETURNS boolean AS $$
  SELECT EXISTS (
           SELECT 1 FROM "invoices" n JOIN "invoices" o ON o."id" = orig_id
           WHERE n."id" = note_id
             AND n."kind" = 'CREDIT_NOTE' AND n."creditedInvoiceId" = o."id" AND n."status" = 'SENT'
             AND o."kind" = 'INVOICE' AND o."status" = 'CANCELLED' AND o."sentAt" IS NOT NULL
             AND n."companyId" = o."companyId" AND n."worksiteId" = o."worksiteId" AND n."clientId" = o."clientId"
             AND n."totalHT" = o."totalHT" AND n."totalVAT" = o."totalVAT" AND n."totalTTC" = o."totalTTC"
             AND n."globalDiscountBp" = o."globalDiscountBp" AND n."vatReverseCharge" = o."vatReverseCharge")
     AND NOT EXISTS (
           (SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp"
              FROM "invoice_lines" WHERE "invoiceId" = note_id
            EXCEPT ALL
            SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp"
              FROM "invoice_lines" WHERE "invoiceId" = orig_id)
           UNION ALL
           (SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp"
              FROM "invoice_lines" WHERE "invoiceId" = orig_id
            EXCEPT ALL
            SELECT "articleId", "designation", "description", "unit", "quantity", "unitPrice", "vatRate", "lineHT", "position", "discountBp"
              FROM "invoice_lines" WHERE "invoiceId" = note_id))
$$ LANGUAGE sql STABLE;
