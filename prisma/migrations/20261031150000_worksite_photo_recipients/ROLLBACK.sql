-- Rollback de 20261031150000_worksite_photo_recipients (NON exécuté automatiquement par Prisma).
-- NON DESTRUCTIF : REFUSE sous verrou dès qu'un destinataire existe ou qu'un chantier est marqué configuré (une liste vidée
-- volontairement est une configuration) ; aucune configuration n'est jamais effacée par ce script.
-- Repli normal = retour au code précédent : la table est alors simplement ignorée.
BEGIN;
LOCK TABLE "worksite_photo_recipients" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "worksites" IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "worksite_photo_recipients") THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : des destinataires de photos sont configurés.';
  END IF;
  IF EXISTS (SELECT 1 FROM "worksites" WHERE "photoRecipientsConfiguredAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'WORKSITE_PHOTOS ROLLBACK REFUSÉ : des chantiers ont une liste de destinataires configurée (même vide).';
  END IF;
END $$;
DROP TRIGGER IF EXISTS "worksite_photo_recipients_guard" ON "worksite_photo_recipients";
DROP FUNCTION IF EXISTS "worksite_photo_recipients_guard"();
DROP TABLE IF EXISTS "worksite_photo_recipients";
ALTER TABLE "worksites" DROP COLUMN IF EXISTS "photoRecipientsConfiguredAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261031150000_worksite_photo_recipients';
COMMIT;
