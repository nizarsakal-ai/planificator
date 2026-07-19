-- PLAN-ACQ-004D-R1 : aligner le nom d'index tronqué par PostgreSQL (63 chars)
-- sur le nom canonique attendu par Prisma.
--
-- Cause : CREATE INDEX ... downloadNextRetryAt_idx (64 chars) a été tronqué
-- par PostgreSQL en ...downloadNextRetryAt_id. Prisma génère
-- ...downloadNextRetryA_idx (suffixe _idx conservé).

ALTER INDEX IF EXISTS "acquisition_attachments_companyId_status_downloadNextRetryAt_id"
  RENAME TO "acquisition_attachments_companyId_status_downloadNextRetryA_idx";
