-- Document Studio, espace PDF (lot 4, 20/11/2026) : la forme des révisions admet REDACTED. Une révision biffée suit la
-- révision précédente comme une révision remplie ou réorganisée (liste empreinte non vide : zones biffées par page et
-- empreinte de l'image de chaque page) et ne porte aucun signataire. Seule la contrainte de forme de
-- "studio_pdf_revisions" (table du lot 1) est remplacée, à l'identique pour les autres types ; aucune ligne modifiée.

BEGIN;

ALTER TABLE "studio_pdf_revisions" DROP CONSTRAINT "studio_pdf_revisions_shape_check";
ALTER TABLE "studio_pdf_revisions" ADD CONSTRAINT "studio_pdf_revisions_shape_check" CHECK (
  "revision" >= 1 AND "size" > 0 AND "size" = octet_length("data") AND "pageCount" >= 1
  AND "sha256" ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof("pages") = 'array' AND jsonb_array_length("pages") = "pageCount"
  AND jsonb_typeof("pageTexts") = 'array'
  AND (("revision" = 1 AND "kind" = 'ORIGINAL' AND "operations" IS NULL AND "operationsSha256" IS NULL AND "signerName" IS NULL AND "signatureSha256" IS NULL)
    OR ("revision" > 1 AND "kind" IN ('FILLED', 'ORGANIZED', 'REDACTED') AND "operations" IS NOT NULL AND jsonb_typeof("operations") = 'array'
        AND jsonb_array_length("operations") > 0 AND "operationsSha256" IS NOT NULL AND "operationsSha256" ~ '^[0-9a-f]{64}$'))
  AND ("kind" NOT IN ('ORGANIZED', 'REDACTED') OR "signerName" IS NULL)
  AND (("signerName" IS NULL AND "signatureSha256" IS NULL)
    OR ("signerName" IS NOT NULL AND length("signerName") BETWEEN 2 AND 120 AND "signatureSha256" IS NOT NULL AND "signatureSha256" ~ '^[0-9a-f]{64}$'))
);

COMMIT;
