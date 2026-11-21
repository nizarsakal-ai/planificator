-- 20/11/2026 — modèles de design des PDF (devis, factures, acomptes, avoirs). Migration ADDITIVE : aucune donnée existante
-- modifiée. Défauts de la société = rendu historique (« Classique », #0f3460, format complet, identifiants client affichés).
CREATE TYPE "PdfTemplate" AS ENUM ('CLASSIC', 'MODERN', 'BAND', 'MINIMAL');
CREATE TYPE "PdfLayout" AS ENUM ('COMPLETE', 'QUICK');

ALTER TABLE "billing_settings"
  ADD COLUMN "pdfTemplate" "PdfTemplate" NOT NULL DEFAULT 'CLASSIC',
  ADD COLUMN "pdfPrimaryColor" TEXT NOT NULL DEFAULT '#0f3460',
  ADD COLUMN "pdfSecondaryColor" TEXT NOT NULL DEFAULT '#0f3460',
  ADD COLUMN "pdfLayout" "PdfLayout" NOT NULL DEFAULT 'COMPLETE',
  ADD COLUMN "pdfShowClientIds" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pdfShowBankDetails" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "invoices"
  ADD COLUMN "pdfTemplate" "PdfTemplate",
  ADD COLUMN "pdfPrimaryColor" TEXT,
  ADD COLUMN "pdfSecondaryColor" TEXT,
  ADD COLUMN "pdfLayout" "PdfLayout",
  ADD COLUMN "pdfShowClientIds" BOOLEAN,
  ADD COLUMN "pdfShowBankDetails" BOOLEAN;

ALTER TABLE "quotes"
  ADD COLUMN "pdfTemplate" "PdfTemplate",
  ADD COLUMN "pdfPrimaryColor" TEXT,
  ADD COLUMN "pdfSecondaryColor" TEXT,
  ADD COLUMN "pdfLayout" "PdfLayout",
  ADD COLUMN "pdfShowClientIds" BOOLEAN,
  ADD COLUMN "pdfShowBankDetails" BOOLEAN;

-- Filet en base : couleurs au format #rrggbb (le contraste est contrôlé par l'application, src/lib/billing/pdf/design.ts).
ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_pdf_colors_check"
  CHECK ("pdfPrimaryColor" ~ '^#[0-9a-f]{6}$' AND "pdfSecondaryColor" ~ '^#[0-9a-f]{6}$');
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pdf_colors_check"
  CHECK (("pdfPrimaryColor" IS NULL OR "pdfPrimaryColor" ~ '^#[0-9a-f]{6}$') AND ("pdfSecondaryColor" IS NULL OR "pdfSecondaryColor" ~ '^#[0-9a-f]{6}$'));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_pdf_colors_check"
  CHECK (("pdfPrimaryColor" IS NULL OR "pdfPrimaryColor" ~ '^#[0-9a-f]{6}$') AND ("pdfSecondaryColor" IS NULL OR "pdfSecondaryColor" ~ '^#[0-9a-f]{6}$'));
