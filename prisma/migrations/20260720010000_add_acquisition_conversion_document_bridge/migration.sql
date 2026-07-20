-- PLAN-ACQ-005D — Bridge Document ↔ AcquisitionAttachment + unicité createdWorksiteId
-- Additive uniquement.

-- Document.url nullable (documents bridgés sans URL publique)
ALTER TABLE "documents" ALTER COLUMN "url" DROP NOT NULL;

-- Référence Cloudinary authenticated (pas d’autorité URL)
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "storagePublicId" TEXT;

-- Lien 1–1 vers la pièce jointe source (idempotence conversion)
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "sourceAcquisitionAttachmentId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "documents_sourceAcquisitionAttachmentId_key"
  ON "documents"("sourceAcquisitionAttachmentId");

-- Un draft converti au plus une fois vers un chantier
CREATE UNIQUE INDEX IF NOT EXISTS "worksite_import_drafts_createdWorksiteId_key"
  ON "worksite_import_drafts"("createdWorksiteId");
