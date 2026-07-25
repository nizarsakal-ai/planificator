-- PLAN-ACQ-012-LOT-1.1 — Registre Sources d'acquisition (partenaires + domaines)
-- Structure uniquement : tables, PK, index, unicités, FK.
-- Aucune insertion de données. Bootstrap lauralu.fr → LOT-1.2.
-- Runtime métier inchangé jusqu'au LOT-1.4 (ELIGIBLE_SENDER_DOMAIN reste la gate).
--
-- Notes de contrat (schéma) :
-- - "connector" réutilise l'enum PostgreSQL existant "AcquisitionSource" (GMAIL V1).
-- - "pipeline" est une clé technique contrôlée (défaut 'consultations'),
--   pas une chaîne libre saisie utilisateur.

-- ── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE "acquisition_partners" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "connector" "AcquisitionSource" NOT NULL DEFAULT 'GMAIL',
    "pipeline" TEXT NOT NULL DEFAULT 'consultations',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_partners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "acquisition_partner_domains" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "domainNormalized" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acquisition_partner_domains_pkey" PRIMARY KEY ("id")
);

-- ── Unicités / index ────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "acquisition_partners_companyId_code_key"
  ON "acquisition_partners"("companyId", "code");

CREATE UNIQUE INDEX "acquisition_partners_id_companyId_key"
  ON "acquisition_partners"("id", "companyId");

CREATE INDEX "acquisition_partners_companyId_active_idx"
  ON "acquisition_partners"("companyId", "active");

CREATE UNIQUE INDEX "acquisition_partner_domains_companyId_domainNormalized_key"
  ON "acquisition_partner_domains"("companyId", "domainNormalized");

CREATE INDEX "acquisition_partner_domains_companyId_active_idx"
  ON "acquisition_partner_domains"("companyId", "active");

CREATE INDEX "acquisition_partner_domains_partnerId_idx"
  ON "acquisition_partner_domains"("partnerId");

-- ── Foreign keys ────────────────────────────────────────────────────────────

ALTER TABLE "acquisition_partners"
  ADD CONSTRAINT "acquisition_partners_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "acquisition_partner_domains"
  ADD CONSTRAINT "acquisition_partner_domains_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- FK composite anti inter-tenant : domaine.companyId = partenaire.companyId
ALTER TABLE "acquisition_partner_domains"
  ADD CONSTRAINT "acquisition_partner_domains_partnerId_companyId_fkey"
  FOREIGN KEY ("partnerId", "companyId")
  REFERENCES "acquisition_partners"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
