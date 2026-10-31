-- Destinataires des photos par chantier — worksite_photo_recipients
-- Migration EXPAND : 1 table, 2 index, 1 FK composite, CHECK, 1 déclencheur, et 1 colonne NULLABLE sur "worksites"
-- (marqueur de configuration). Aucune ligne écrite. `worksites.clientContact` (contrat agent v1, une adresse) n'est
-- ni modifié ni lu ici.
-- Marqueur `photoRecipientsConfiguredAt` : NULL = liste jamais configurée ; posé une fois, par la base, dans la
-- transaction du premier enregistrement (y compris une liste vide). Il distingue « jamais configurée » de « vidée
-- volontairement » : une liste vide ou entièrement inactive ne réactive JAMAIS l'adresse historique.
-- Contrat (docs/specs/worksite-photos/LOT-PHOTO-RECIPIENTS.md) : plusieurs destinataires par chantier, 20 au plus,
-- adresse unique par chantier (insensible à la casse), désactivation sans effacement, configuration SUPER_ADMIN,
-- AUCUN envoi automatique.

BEGIN;

ALTER TABLE "worksites" ADD COLUMN "photoRecipientsConfiguredAt" TIMESTAMPTZ(3);

CREATE TABLE "worksite_photo_recipients" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "worksiteId" TEXT NOT NULL,
    "label" TEXT,
    "email" TEXT NOT NULL,
    "emailKey" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "worksite_photo_recipients_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "worksite_photo_recipients_companyId_worksiteId_position_idx" ON "worksite_photo_recipients"("companyId", "worksiteId", "position");

CREATE UNIQUE INDEX "worksite_photo_recipients_worksiteId_emailKey_key" ON "worksite_photo_recipients"("worksiteId", "emailKey");

-- Tenant : le chantier référencé appartient à la même entreprise ; configuration supprimée avec le chantier.
-- Nom hors du motif `worksite_photo%_fkey` que comptent les assertions de la migration du Lot 1 (aucun couplage).
ALTER TABLE "worksite_photo_recipients" ADD CONSTRAINT "photo_recipients_worksite_companyId_fkey" FOREIGN KEY ("worksiteId", "companyId") REFERENCES "worksites"("id", "companyId") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "worksite_photo_recipients"
  ADD CONSTRAINT "worksite_photo_recipients_values_check" CHECK (
    length("email") BETWEEN 3 AND 254
    AND "email" = btrim("email")
    AND "email" !~ '[[:space:],;<>]'
    AND "email" ~ '^[^@]+@[^@]+\.[^@]+$'
    AND "emailKey" = lower("email")
    AND ("label" IS NULL OR (length(btrim("label")) BETWEEN 1 AND 120 AND "label" = btrim("label")))
    AND "position" BETWEEN 0 AND 19
    AND length(btrim("createdById")) > 0 AND length(btrim("updatedById")) > 0
  );

-- Défense en profondeur : 20 destinataires au plus par chantier. Le déclencheur verrouille lui-même le chantier
-- (FOR UPDATE, même tenant) AVANT de compter : deux insertions concurrentes, même hors du service, sont sérialisées et
-- la seconde voit la première (READ COMMITTED : nouvel instantané par instruction). Identité et création figées ;
-- updatedAt posé par la base.
CREATE FUNCTION "worksite_photo_recipients_guard"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM "worksites" WHERE "id" = NEW."worksiteId" AND "companyId" = NEW."companyId" FOR UPDATE;
    IF (SELECT count(*) FROM "worksite_photo_recipients" WHERE "worksiteId" = NEW."worksiteId" AND "companyId" = NEW."companyId") >= 20 THEN
      RAISE EXCEPTION 'WORKSITE_PHOTOS: 20 destinataires au plus par chantier.'
        USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_recipients_limit_check';
    END IF;
    NEW."createdAt" := clock_timestamp();
    NEW."updatedAt" := NEW."createdAt";
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."companyId" <> OLD."companyId" OR NEW."worksiteId" <> OLD."worksiteId"
     OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: identité et création d''un destinataire sont figées.'
      USING ERRCODE = '23514', CONSTRAINT = 'worksite_photo_recipients_immutable_check';
  END IF;
  NEW."updatedAt" := clock_timestamp();
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "worksite_photo_recipients_guard"
  BEFORE INSERT OR UPDATE ON "worksite_photo_recipients" FOR EACH ROW
  EXECUTE FUNCTION "worksite_photo_recipients_guard"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "worksites" WHERE "photoRecipientsConfiguredAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: aucun chantier ne doit être marqué configuré par la migration.';
  END IF;
  IF to_regclass('"worksite_photo_recipients"') IS NULL THEN RAISE EXCEPTION 'WORKSITE_PHOTOS: table des destinataires absente.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'worksite_photo_recipients_guard') THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS: déclencheur des destinataires absent.';
  END IF;
  IF EXISTS (SELECT 1 FROM "worksite_photo_recipients") THEN RAISE EXCEPTION 'WORKSITE_PHOTOS: la table doit être vide à la création.'; END IF;
END $$;

COMMIT;
