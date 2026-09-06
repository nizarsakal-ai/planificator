-- PLAN-ACQ-AGENTS-LOT-3D/3E-CORRECTION-4A — idempotencyKey nullable + unique (NULL legacy OK).
ALTER TABLE "acquisition_decision_journals" ADD COLUMN "idempotencyKey" TEXT;

-- PostgreSQL UNIQUE : plusieurs NULL autorisés ; unicité stricte des valeurs non nulles.
CREATE UNIQUE INDEX "acquisition_decision_journals_idempotencyKey_key"
  ON "acquisition_decision_journals"("idempotencyKey");
