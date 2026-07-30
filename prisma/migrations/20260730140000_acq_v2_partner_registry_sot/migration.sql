-- PLAN-ACQ-V2 Lot I — Registre SoT : policy partenaire, emails, resolvedPartnerId

ALTER TABLE "acquisition_partners"
  ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "requireExactEmail" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "autoApproveEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "autoConvertEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "allowCreateClient" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "minConfidence" DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS "acquisition_partners_companyId_priority_idx"
  ON "acquisition_partners"("companyId", "priority");

CREATE TABLE IF NOT EXISTS "acquisition_partner_emails" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_partner_emails_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "acquisition_partner_emails_companyId_emailNormalized_key"
  ON "acquisition_partner_emails"("companyId", "emailNormalized");

CREATE UNIQUE INDEX IF NOT EXISTS "acquisition_partner_emails_id_companyId_key"
  ON "acquisition_partner_emails"("id", "companyId");

CREATE INDEX IF NOT EXISTS "acquisition_partner_emails_companyId_active_idx"
  ON "acquisition_partner_emails"("companyId", "active");

CREATE INDEX IF NOT EXISTS "acquisition_partner_emails_partnerId_idx"
  ON "acquisition_partner_emails"("partnerId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'acquisition_partner_emails_companyId_fkey'
  ) THEN
    ALTER TABLE "acquisition_partner_emails"
      ADD CONSTRAINT "acquisition_partner_emails_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'acquisition_partner_emails_partnerId_companyId_fkey'
  ) THEN
    ALTER TABLE "acquisition_partner_emails"
      ADD CONSTRAINT "acquisition_partner_emails_partnerId_companyId_fkey"
      FOREIGN KEY ("partnerId", "companyId") REFERENCES "acquisition_partners"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "acquisition_messages"
  ADD COLUMN IF NOT EXISTS "resolvedPartnerId" TEXT;

CREATE INDEX IF NOT EXISTS "acquisition_messages_companyId_resolvedPartnerId_idx"
  ON "acquisition_messages"("companyId", "resolvedPartnerId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'acquisition_messages_resolvedPartnerId_fkey'
  ) THEN
    ALTER TABLE "acquisition_messages"
      ADD CONSTRAINT "acquisition_messages_resolvedPartnerId_fkey"
      FOREIGN KEY ("resolvedPartnerId") REFERENCES "acquisition_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
