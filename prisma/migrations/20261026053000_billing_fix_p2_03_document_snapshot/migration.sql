-- Correctif Lot C — P2-03 (revue Codex du 26/10/2026) : réédition fidèle d'une pièce émise.
-- À l'émission d'une facture, d'un acompte ou d'un avoir, les données documentaires utilisées (identité vendeur, identité
-- acheteur, mentions/régime, conditions, pied de page, chantier, références) sont FIGÉES dans un snapshot structuré versionné,
-- immuable en base (ni UPDATE ni DELETE). Les montants/lignes restent protégés par les déclencheurs Lot B/C.
-- Une pièce émise AVANT cette migration n'a pas de snapshot : la réédition le signale (« snapshot historique indisponible »),
-- aucun historique n'est reconstruit ni antidaté par la migration.

CREATE TABLE "invoice_document_snapshots" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "seller" JSONB NOT NULL,
    "buyer" JSONB NOT NULL,
    "document" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_document_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_document_snapshots_invoiceId_key" ON "invoice_document_snapshots"("invoiceId");
CREATE INDEX "invoice_document_snapshots_companyId_idx" ON "invoice_document_snapshots"("companyId");
ALTER TABLE "invoice_document_snapshots" ADD CONSTRAINT "invoice_document_snapshots_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_document_snapshots" ADD CONSTRAINT "invoice_document_snapshots_companyId_invoiceId_fkey" FOREIGN KEY ("companyId", "invoiceId") REFERENCES "invoices"("companyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Immuable : seul l'INSERT est permis, pour une pièce émise (hors brouillon, date d'émission posée).
CREATE OR REPLACE FUNCTION invoice_document_snapshots_guard() RETURNS trigger AS $$
DECLARE inv record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'DOCUMENT_SNAPSHOT_IMMUTABLE: le snapshot documentaire d''une pièce émise ne se modifie ni ne se supprime.';
  END IF;
  SELECT "status", "sentAt", "companyId" INTO inv FROM "invoices" WHERE "id" = NEW."invoiceId";
  IF NOT FOUND OR inv."companyId" <> NEW."companyId" OR inv."status"::text = 'DRAFT' OR inv."sentAt" IS NULL THEN
    RAISE EXCEPTION 'DOCUMENT_SNAPSHOT_INVALID: un snapshot ne se fige que pour une pièce émise de la même société.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_document_snapshots_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON "invoice_document_snapshots"
  FOR EACH ROW EXECUTE FUNCTION invoice_document_snapshots_guard();
