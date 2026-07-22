-- PLAN-ACQ-OPS-003-R1 : aligner noms tronqués PostgreSQL (63 chars)
-- sur les noms canoniques attendus par Prisma.

ALTER TABLE "acquisition_content_fetch_states"
  RENAME CONSTRAINT
    "acquisition_content_fetch_states_acquisitionMessageId_companyId"
  TO
    "acquisition_content_fetch_states_acquisitionMessageId_comp_fkey";

ALTER INDEX "acquisition_content_fetch_states_acquisitionMessageId_companyId"
  RENAME TO "acquisition_content_fetch_states_acquisitionMessageId_compa_key";

ALTER INDEX "acquisition_content_fetch_states_companyId_terminalAt_nextRetry"
  RENAME TO "acquisition_content_fetch_states_companyId_terminalAt_nextR_idx";
