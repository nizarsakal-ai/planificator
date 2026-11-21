-- 21/11/2026 — documents de facturation : options de facture (adresse de livraison, intitulé, langue), bons de commande clients,
-- bons de livraison. Migration ADDITIVE : aucune donnée existante modifiée. À appliquer avec le rôle propriétaire (neondb_owner),
-- conformément à docs/runbooks/DB-APP-ROLE.md (le build de production vérifie seulement que la base est à jour).

-- CreateEnum
CREATE TYPE "PdfLanguage" AS ENUM ('FR', 'EN');

-- CreateEnum
CREATE TYPE "ClientOrderStatus" AS ENUM ('ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryNoteStatus" AS ENUM ('ISSUED', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryNoteSource" AS ENUM ('QUOTE', 'INVOICE', 'CLIENT_ORDER');

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "pdfLanguage" "PdfLanguage",
ADD COLUMN     "pdfShowDeliveryAddress" BOOLEAN;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "deliveryAddress" TEXT,
ADD COLUMN     "documentTitle" TEXT,
ADD COLUMN     "pdfLanguage" "PdfLanguage",
ADD COLUMN     "pdfShowDeliveryAddress" BOOLEAN;

-- AlterTable
ALTER TABLE "billing_settings" ADD COLUMN     "pdfLanguage" "PdfLanguage" NOT NULL DEFAULT 'FR',
ADD COLUMN     "pdfShowDeliveryAddress" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "deliveryAddress" TEXT;

-- CreateTable
CREATE TABLE "client_orders" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "worksiteId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "ClientOrderStatus" NOT NULL DEFAULT 'ISSUED',
    "issueDate" DATE NOT NULL,
    "expectedDeliveryDate" DATE,
    "clientReference" TEXT,
    "deliveryAddress" TEXT,
    "subject" TEXT,
    "notes" TEXT,
    "globalDiscountBp" INTEGER NOT NULL DEFAULT 0,
    "vatReverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "totalHT" DECIMAL(10,2) NOT NULL,
    "totalVAT" DECIMAL(10,2) NOT NULL,
    "totalTTC" DECIMAL(10,2) NOT NULL,
    "createdById" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_order_lines" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "articleId" TEXT,
    "designation" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'u',
    "quantity" DECIMAL(10,2) NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "vatRate" DECIMAL(5,2) NOT NULL,
    "lineHT" DECIMAL(10,2) NOT NULL,
    "discountBp" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "client_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_notes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "DeliveryNoteStatus" NOT NULL DEFAULT 'ISSUED',
    "sourceType" "DeliveryNoteSource" NOT NULL,
    "quoteId" TEXT,
    "invoiceId" TEXT,
    "clientOrderId" TEXT,
    "clientId" TEXT NOT NULL,
    "worksiteId" TEXT NOT NULL,
    "deliveryDate" DATE NOT NULL,
    "deliveryAddress" TEXT,
    "notes" TEXT,
    "receivedByName" TEXT,
    "receivedAt" DATE,
    "createdById" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_note_lines" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "designation" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'u',
    "quantityOrdered" DECIMAL(10,2) NOT NULL,
    "quantityDelivered" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "delivery_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_orders_companyId_quoteId_idx" ON "client_orders"("companyId", "quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "client_orders_companyId_number_key" ON "client_orders"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "client_orders_id_companyId_key" ON "client_orders"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "client_order_lines_orderId_position_key" ON "client_order_lines"("orderId", "position");

-- CreateIndex
CREATE INDEX "delivery_notes_companyId_status_idx" ON "delivery_notes"("companyId", "status");

-- CreateIndex
CREATE INDEX "delivery_notes_quoteId_idx" ON "delivery_notes"("quoteId");

-- CreateIndex
CREATE INDEX "delivery_notes_invoiceId_idx" ON "delivery_notes"("invoiceId");

-- CreateIndex
CREATE INDEX "delivery_notes_clientOrderId_idx" ON "delivery_notes"("clientOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_notes_companyId_number_key" ON "delivery_notes"("companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_note_lines_noteId_position_key" ON "delivery_note_lines"("noteId", "position");

-- AddForeignKey
ALTER TABLE "client_orders" ADD CONSTRAINT "client_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_orders" ADD CONSTRAINT "client_orders_quoteId_companyId_fkey" FOREIGN KEY ("quoteId", "companyId") REFERENCES "quotes"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_orders" ADD CONSTRAINT "client_orders_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_orders" ADD CONSTRAINT "client_orders_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_order_lines" ADD CONSTRAINT "client_order_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "client_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_quoteId_companyId_fkey" FOREIGN KEY ("quoteId", "companyId") REFERENCES "quotes"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_invoiceId_companyId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_clientOrderId_companyId_fkey" FOREIGN KEY ("clientOrderId", "companyId") REFERENCES "client_orders"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "delivery_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Règles métier garanties en base ─────────────────────────────────────────────────────────────────────────────────────
-- Un seul bon de commande client ACTIF (non annulé) par devis.
CREATE UNIQUE INDEX "client_orders_one_active_per_quote_key" ON "client_orders"("companyId", "quoteId") WHERE "status" <> 'CANCELLED';
ALTER TABLE "client_orders" ADD CONSTRAINT "client_orders_totals_check" CHECK ("totalHT" >= 0 AND "totalVAT" >= 0 AND "totalTTC" >= 0);
ALTER TABLE "client_orders" ADD CONSTRAINT "client_orders_cancel_check" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));
-- Bon de livraison : exactement la source déclarée.
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_source_check" CHECK (
  ("sourceType" = 'QUOTE' AND "quoteId" IS NOT NULL AND "invoiceId" IS NULL AND "clientOrderId" IS NULL) OR
  ("sourceType" = 'INVOICE' AND "invoiceId" IS NOT NULL AND "quoteId" IS NULL AND "clientOrderId" IS NULL) OR
  ("sourceType" = 'CLIENT_ORDER' AND "clientOrderId" IS NOT NULL AND "quoteId" IS NULL AND "invoiceId" IS NULL));
-- Réception enregistrée ⇔ statut DELIVERED (nom et date obligatoires) ; annulation datée.
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_receipt_check" CHECK (
  ("status" = 'DELIVERED') = ("receivedByName" IS NOT NULL AND "receivedAt" IS NOT NULL));
ALTER TABLE "delivery_notes" ADD CONSTRAINT "delivery_notes_cancel_check" CHECK (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL));
ALTER TABLE "delivery_note_lines" ADD CONSTRAINT "delivery_note_lines_quantities_check" CHECK ("quantityOrdered" >= 0 AND "quantityDelivered" >= 0);
