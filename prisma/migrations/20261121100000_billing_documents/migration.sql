-- 21/11/2026 — documents de facturation : options de facture (adresse de livraison, intitulé, langue), bons de commande clients,
-- bons de livraison. Migration ADDITIVE : aucune donnée existante modifiée. À appliquer avec le rôle propriétaire (neondb_owner).

-- Lot A — options de facture
CREATE TYPE "PdfLanguage" AS ENUM ('FR', 'EN');
ALTER TABLE "clients" ADD COLUMN "deliveryAddress" TEXT;
ALTER TABLE "billing_settings"
  ADD COLUMN "pdfShowDeliveryAddress" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pdfLanguage" "PdfLanguage" NOT NULL DEFAULT 'FR';
ALTER TABLE "invoices"
  ADD COLUMN "pdfShowDeliveryAddress" BOOLEAN,
  ADD COLUMN "pdfLanguage" "PdfLanguage",
  ADD COLUMN "deliveryAddress" TEXT,
  ADD COLUMN "documentTitle" TEXT;
ALTER TABLE "quotes"
  ADD COLUMN "pdfShowDeliveryAddress" BOOLEAN,
  ADD COLUMN "pdfLanguage" "PdfLanguage";
