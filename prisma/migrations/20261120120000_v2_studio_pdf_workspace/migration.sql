-- Document Studio, espace PDF (lots 1 et 2, 20/11/2026). Migration EXPAND, additive : 1 type et 2 tables nouveaux,
-- leurs index et clés. Aucun objet existant modifié, aucune ligne existante lue ni écrite. Corps généré par
-- `prisma migrate diff` (schéma précédent vers ce lot), puis CHECK, index partiel et déclencheurs à la main en fin de
-- fichier. Module désactivé par défaut (DOCUMENT_STUDIO_ENABLED).
-- Garanties portées par la base : un PDF n'est jamais supprimé ; ses révisions sont numérotées sans trou à partir de 1,
-- la révision 1 est l'original importé et elle seule ; une révision ne se modifie ni ne se supprime ; une révision
-- remplie porte la liste empreinte de ses éléments ; une signature posée porte le nom du signataire et l'empreinte du
-- tracé ; un même original n'est importé qu'une fois par entreprise.

BEGIN;

-- CreateEnum
CREATE TYPE "StudioPdfRevisionKind" AS ENUM ('ORIGINAL', 'FILLED');

-- CreateTable
CREATE TABLE "studio_pdfs" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "studio_pdfs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "studio_pdf_revisions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "pdfId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" "StudioPdfRevisionKind" NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "pages" JSONB NOT NULL,
    "pageTexts" JSONB NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "operations" JSONB,
    "operationsSha256" TEXT,
    "signerName" TEXT,
    "signatureSha256" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "studio_pdf_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "studio_pdfs_companyId_createdAt_idx" ON "studio_pdfs"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "studio_pdfs_companyId_id_key" ON "studio_pdfs"("companyId", "id");

-- CreateIndex
CREATE INDEX "studio_pdf_revisions_companyId_pdfId_idx" ON "studio_pdf_revisions"("companyId", "pdfId");

-- CreateIndex
CREATE UNIQUE INDEX "studio_pdf_revisions_companyId_id_key" ON "studio_pdf_revisions"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "studio_pdf_revisions_pdfId_revision_key" ON "studio_pdf_revisions"("pdfId", "revision");

-- AddForeignKey
ALTER TABLE "studio_pdfs" ADD CONSTRAINT "studio_pdfs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio_pdf_revisions" ADD CONSTRAINT "studio_pdf_revisions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio_pdf_revisions" ADD CONSTRAINT "studio_pdf_revisions_companyId_pdfId_fkey" FOREIGN KEY ("companyId", "pdfId") REFERENCES "studio_pdfs"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Contraintes (ajouts manuels) ───────────────────────────────────────────────────────────────────────────────────
ALTER TABLE "studio_pdf_revisions" ADD CONSTRAINT "studio_pdf_revisions_shape_check" CHECK (
  "revision" >= 1 AND "size" > 0 AND "size" = octet_length("data") AND "pageCount" >= 1
  AND "sha256" ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof("pages") = 'array' AND jsonb_array_length("pages") = "pageCount"
  AND jsonb_typeof("pageTexts") = 'array'
  AND (("revision" = 1 AND "kind" = 'ORIGINAL' AND "operations" IS NULL AND "operationsSha256" IS NULL AND "signerName" IS NULL AND "signatureSha256" IS NULL)
    OR ("revision" > 1 AND "kind" = 'FILLED' AND "operations" IS NOT NULL AND jsonb_typeof("operations") = 'array'
        AND "operationsSha256" IS NOT NULL AND "operationsSha256" ~ '^[0-9a-f]{64}$'))
  AND (("signerName" IS NULL AND "signatureSha256" IS NULL)
    OR ("signerName" IS NOT NULL AND length("signerName") BETWEEN 2 AND 120 AND "signatureSha256" IS NOT NULL AND "signatureSha256" ~ '^[0-9a-f]{64}$'))
);
ALTER TABLE "studio_pdfs" ADD CONSTRAINT "studio_pdfs_title_check" CHECK (length("title") BETWEEN 3 AND 160 AND length("originalName") BETWEEN 1 AND 160);

-- Un même original (mêmes octets) n'est importé qu'une fois par entreprise.
CREATE UNIQUE INDEX "studio_pdf_revisions_one_original_per_content" ON "studio_pdf_revisions"("companyId", "sha256") WHERE "kind" = 'ORIGINAL';

-- ── Déclencheurs (ajouts manuels) ────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION studio_pdf_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'studio pdf history immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER studio_pdfs_no_truncate BEFORE TRUNCATE ON "studio_pdfs"
  FOR EACH STATEMENT EXECUTE FUNCTION studio_pdf_no_truncate();
CREATE TRIGGER studio_pdf_revisions_no_truncate BEFORE TRUNCATE ON "studio_pdf_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION studio_pdf_no_truncate();

-- PDF : jamais supprimé ; identité figée (le titre reste modifiable).
CREATE FUNCTION studio_pdf_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'studio pdf cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (NEW."id", NEW."companyId", NEW."originalName", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM (OLD."id", OLD."companyId", OLD."originalName", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'studio pdf identity immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER studio_pdfs_guard BEFORE UPDATE OR DELETE ON "studio_pdfs"
  FOR EACH ROW EXECUTE FUNCTION studio_pdf_guard();

-- Révision : jamais modifiée ni supprimée ; numérotation sans trou (la précédente existe pour le même PDF).
CREATE FUNCTION studio_pdf_revision_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'studio pdf revision immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" > 1 AND NOT EXISTS (
    SELECT 1 FROM "studio_pdf_revisions" r
      WHERE r."pdfId" = NEW."pdfId" AND r."companyId" = NEW."companyId" AND r."revision" = NEW."revision" - 1
  ) THEN
    RAISE EXCEPTION 'studio pdf revision must follow the previous one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER studio_pdf_revisions_guard BEFORE INSERT OR UPDATE OR DELETE ON "studio_pdf_revisions"
  FOR EACH ROW EXECUTE FUNCTION studio_pdf_revision_guard();

COMMIT;
