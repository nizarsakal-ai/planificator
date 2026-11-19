-- Lot G Planificator V2 (04/11/2026) : Document Studio (évolution 10). Migration EXPAND, additive : 2 types et 3
-- tables nouveaux, leurs index et clés. Aucun objet existant modifié, aucune ligne existante lue ni écrite ; les PDF
-- existants (devis, factures, paie, rapports…) ne sont pas concernés. Corps généré par `prisma migrate diff` (schéma
-- lot F vers ce lot), puis CHECK, index partiels et déclencheurs à la main en fin de fichier. Module désactivé par
-- défaut (DOCUMENT_STUDIO_ENABLED).
-- Garanties portées par la base : un seul brouillon et une seule version publiée par modèle ; version publiée ou
-- retirée figée ; un document naît d'une version PUBLIÉE de la même entreprise, dans l'état qu'elle impose ; contenu
-- d'un document figé ; décision unique ; validation par un autre utilisateur que l'auteur, avec signature.

BEGIN;

-- CreateEnum
CREATE TYPE "DocumentTemplateVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "GeneratedDocumentStatus" AS ENUM ('PENDING_APPROVAL', 'ISSUED', 'REJECTED');

-- CreateTable
CREATE TABLE "document_templates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_template_versions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DocumentTemplateVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "contentSha256" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "document_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_documents" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotSha256" TEXT NOT NULL,
    "status" "GeneratedDocumentStatus" NOT NULL,
    "clientId" TEXT,
    "worksiteId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "signerName" TEXT,
    "signaturePng" BYTEA,
    "signatureSha256" TEXT,
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,

    CONSTRAINT "generated_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_templates_companyId_id_key" ON "document_templates"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_templates_companyId_name_key" ON "document_templates"("companyId", "name");

-- CreateIndex
CREATE INDEX "document_template_versions_companyId_templateId_status_idx" ON "document_template_versions"("companyId", "templateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "document_template_versions_companyId_id_key" ON "document_template_versions"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_template_versions_templateId_version_key" ON "document_template_versions"("templateId", "version");

-- CreateIndex
CREATE INDEX "generated_documents_companyId_status_createdAt_idx" ON "generated_documents"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "generated_documents_companyId_versionId_idx" ON "generated_documents"("companyId", "versionId");

-- CreateIndex
CREATE INDEX "generated_documents_clientId_companyId_idx" ON "generated_documents"("clientId", "companyId");

-- CreateIndex
CREATE INDEX "generated_documents_worksiteId_companyId_idx" ON "generated_documents"("worksiteId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "generated_documents_companyId_id_key" ON "generated_documents"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "generated_documents_companyId_number_key" ON "generated_documents"("companyId", "number");

-- AddForeignKey
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_companyId_templateId_fkey" FOREIGN KEY ("companyId", "templateId") REFERENCES "document_templates"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_companyId_versionId_fkey" FOREIGN KEY ("companyId", "versionId") REFERENCES "document_template_versions"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_worksiteId_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Défense en profondeur (ajouts manuels) ───────────────────────────────────────────────────────────────────────

-- Un seul brouillon et une seule version publiée par modèle.
CREATE UNIQUE INDEX "document_template_versions_one_draft" ON "document_template_versions"("templateId") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "document_template_versions_one_published" ON "document_template_versions"("templateId") WHERE "status" = 'PUBLISHED';

ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_values_check" CHECK (
  length(btrim("name")) BETWEEN 3 AND 120
  AND "category" IN ('CONTRACT', 'CERTIFICATE', 'LETTER', 'REPORT', 'OTHER')
  AND length(btrim("createdById")) > 0
);

ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_values_check" CHECK (
  "version" >= 1
  AND length(btrim("title")) BETWEEN 3 AND 200
  AND length("body") BETWEEN 1 AND 20000
  AND jsonb_typeof("fields") = 'array' AND jsonb_array_length("fields") <= 40
  AND length(btrim("createdById")) > 0
  AND (
    ("status" = 'DRAFT' AND "contentSha256" IS NULL AND "publishedById" IS NULL AND "publishedAt" IS NULL AND "retiredAt" IS NULL)
    -- Revue Codex du 05/11 : IS NOT NULL explicites (une comparaison sur NULL vaut NULL, que le CHECK admettrait).
    OR ("status" = 'PUBLISHED' AND "contentSha256" IS NOT NULL AND "contentSha256" ~ '^[0-9a-f]{64}$' AND "publishedById" IS NOT NULL AND "publishedAt" IS NOT NULL AND "retiredAt" IS NULL)
    OR ("status" = 'RETIRED' AND "contentSha256" IS NOT NULL AND "contentSha256" ~ '^[0-9a-f]{64}$' AND "publishedById" IS NOT NULL AND "publishedAt" IS NOT NULL AND "retiredAt" IS NOT NULL)
  )
);

ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_values_check" CHECK (
  "number" ~ '^DOC-[0-9]{4}-[0-9]{4,}$'
  AND length("title") BETWEEN 1 AND 200
  AND jsonb_typeof("values") = 'object'
  AND jsonb_typeof("snapshot") = 'object'
  AND "snapshotSha256" ~ '^[0-9a-f]{64}$'
  AND length(btrim("createdById")) > 0
  AND ("signerName" IS NULL OR length(btrim("signerName")) BETWEEN 2 AND 120)
  AND ("signaturePng" IS NULL OR octet_length("signaturePng") BETWEEN 1 AND 300000)
  AND ("rejectReason" IS NULL OR length(btrim("rejectReason")) BETWEEN 3 AND 500)
  AND (
    ("status" = 'PENDING_APPROVAL'
      AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "signerName" IS NULL AND "signaturePng" IS NULL AND "signatureSha256" IS NULL
      AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectReason" IS NULL)
    OR ("status" = 'ISSUED' AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectReason" IS NULL
      AND (
        ("approvedById" IS NULL AND "approvedAt" IS NULL AND "signerName" IS NULL AND "signaturePng" IS NULL AND "signatureSha256" IS NULL)
        OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "signerName" IS NOT NULL AND "signaturePng" IS NOT NULL
            AND "signatureSha256" IS NOT NULL AND "signatureSha256" ~ '^[0-9a-f]{64}$' AND "approvedById" <> "createdById")
      ))
    OR ("status" = 'REJECTED'
      AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "signerName" IS NULL AND "signaturePng" IS NULL AND "signatureSha256" IS NULL
      AND "rejectedById" IS NOT NULL AND "rejectedAt" IS NOT NULL AND "rejectReason" IS NOT NULL AND "rejectedById" <> "createdById")
  )
);

-- ── Déclencheurs (ajouts manuels) ────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION lot_g_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lot G history immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER document_templates_no_truncate BEFORE TRUNCATE ON "document_templates"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_g_no_truncate();
CREATE TRIGGER document_template_versions_no_truncate BEFORE TRUNCATE ON "document_template_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_g_no_truncate();
CREATE TRIGGER generated_documents_no_truncate BEFORE TRUNCATE ON "generated_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION lot_g_no_truncate();

-- Modèle : jamais supprimé ; identité figée.
CREATE FUNCTION document_template_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document template cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."createdById", NEW."createdAt") IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'document template identity immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_templates_guard BEFORE UPDATE OR DELETE ON "document_templates"
  FOR EACH ROW EXECUTE FUNCTION document_template_guard();

-- Version : naît en brouillon ; jamais supprimée ; identité figée ; contenu figé hors brouillon ;
-- transitions DRAFT → PUBLISHED → RETIRED seulement.
CREATE FUNCTION document_template_version_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document template version cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'document template version must start as draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."companyId", NEW."templateId", NEW."version", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."templateId", OLD."version", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'document template version identity immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (NEW."title", NEW."body", NEW."fields", NEW."requiresApproval", NEW."contentSha256", NEW."publishedById", NEW."publishedAt")
     IS DISTINCT FROM (OLD."title", OLD."body", OLD."fields", OLD."requiresApproval", OLD."contentSha256", OLD."publishedById", OLD."publishedAt") THEN
    RAISE EXCEPTION 'published document template version immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" = 'PUBLISHED') OR (OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED')
  ) THEN
    RAISE EXCEPTION 'document template version status transition not allowed' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'RETIRED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'published document template version immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_template_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON "document_template_versions"
  FOR EACH ROW EXECUTE FUNCTION document_template_version_guard();

-- Document : naît d'une version PUBLIÉE de la même entreprise, en attente si elle exige une validation, émis sinon ;
-- jamais supprimé ; contenu figé ; seule décision possible : en attente → émis (validé) ou refusé.
CREATE FUNCTION generated_document_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  needs_approval BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'generated document cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT v."requiresApproval" INTO needs_approval FROM "document_template_versions" v
      WHERE v."id" = NEW."versionId" AND v."companyId" = NEW."companyId" AND v."status" = 'PUBLISHED';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'generated document requires a published version' USING ERRCODE = '23514';
    END IF;
    IF NEW."status" IS DISTINCT FROM (CASE WHEN needs_approval THEN 'PENDING_APPROVAL' ELSE 'ISSUED' END)::"GeneratedDocumentStatus"
       OR NEW."approvedById" IS NOT NULL OR NEW."rejectedById" IS NOT NULL THEN
      RAISE EXCEPTION 'generated document initial status mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."companyId", NEW."versionId", NEW."number", NEW."title", NEW."values", NEW."snapshot", NEW."snapshotSha256", NEW."clientId", NEW."worksiteId", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."versionId", OLD."number", OLD."title", OLD."values", OLD."snapshot", OLD."snapshotSha256", OLD."clientId", OLD."worksiteId", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'generated document content immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'generated document already decided' USING ERRCODE = '23514';
  END IF;
  -- Validation = signature exigée ; validation et refus par un autre utilisateur que l'auteur.
  IF NEW."status" = 'ISSUED' AND (NEW."approvedById" IS NULL OR NEW."signaturePng" IS NULL OR NEW."signatureSha256" IS NULL OR NEW."signerName" IS NULL) THEN
    RAISE EXCEPTION 'generated document approval requires a signature' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER generated_documents_guard BEFORE INSERT OR UPDATE OR DELETE ON "generated_documents"
  FOR EACH ROW EXECUTE FUNCTION generated_document_guard();

COMMIT;
