-- PLAN-ACQ-004C : index de sélection FIFO des PJ DISCOVERED par tenant.
CREATE INDEX "acquisition_attachments_companyId_status_createdAt_idx"
  ON "acquisition_attachments"("companyId", "status", "createdAt");
