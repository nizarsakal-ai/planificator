-- PLAN-ACQ-005A-R3 : aligner le nom de FK tronqué par PostgreSQL (63 chars)
-- sur le nom canonique attendu par Prisma.
--
-- Cause : CONSTRAINT ...acquisitionMessageId_companyId_fkey (64 chars)
-- a été tronqué par PostgreSQL en ...companyId_fke.
-- Prisma génère ...companyI_fkey (suffixe _fkey conservé).

ALTER TABLE "acquisition_message_contents"
  RENAME CONSTRAINT
  "acquisition_message_contents_acquisitionMessageId_companyId_fke"
  TO
  "acquisition_message_contents_acquisitionMessageId_companyI_fkey";
