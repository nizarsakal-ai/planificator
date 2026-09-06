-- PLAN-ACQ-CONSULTATIONS-FIX-001 — Lien nullable Partner → Client (tenant-safe)

-- Cible FK composite : (id, companyId) unique sur clients
CREATE UNIQUE INDEX IF NOT EXISTS "clients_id_companyId_key"
  ON "clients"("id", "companyId");

ALTER TABLE "acquisition_partners"
  ADD COLUMN IF NOT EXISTS "clientId" TEXT;

CREATE INDEX IF NOT EXISTS "acquisition_partners_companyId_clientId_idx"
  ON "acquisition_partners"("companyId", "clientId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'acquisition_partners_clientId_companyId_fkey'
  ) THEN
    ALTER TABLE "acquisition_partners"
      ADD CONSTRAINT "acquisition_partners_clientId_companyId_fkey"
      FOREIGN KEY ("clientId", "companyId")
      REFERENCES "clients"("id", "companyId")
      ON DELETE RESTRICT
      ON UPDATE CASCADE;
  END IF;
END $$;
