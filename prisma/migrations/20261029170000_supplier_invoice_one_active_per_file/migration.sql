-- Factures fournisseurs, correction M2 (29/10/2026) — GO de conception Codex (plan DIAGNOSTIC-INTEGRATION-MAIN-ET-PLAN) ; application
-- réelle soumise au GO de publication et à un pré-contrôle Neon refait juste avant (0 doublon actif constaté en lecture seule le 29/10).
-- Une pièce (supplier_invoice_files) ne peut être rattachée qu'à UNE facture fournisseur ACTIVE (statut ≠ REJECTED) par société.
-- Les factures REJETÉES libèrent leur pièce (réimport et nouvelle saisie autorisés) ; la validation (PENDING → VALIDATED) ne crée pas
-- de ligne et n'est pas affectée ; les factures sans fichier (saisie manuelle) ne sont pas concernées (fileId NULL).
-- Convention du dépôt (migrations R2/A2) : pré-contrôle qui ARRÊTE la migration si des doublons actifs existent — résolution manuelle,
-- jamais de réparation automatique des données.
-- Prisma 5.22 ne représente pas les index partiels : SQL brut, comme supplier_invoices_one_validated_per_number_key (R2).
-- Retour arrière : DROP INDEX "supplier_invoices_one_active_per_file_key";
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT "companyId", "fileId" FROM "supplier_invoices" WHERE "fileId" IS NOT NULL AND "status"::text <> 'REJECTED'
    GROUP BY "companyId", "fileId" HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'SUPPLIER_FILE_PRECHECK: % pièces sont rattachées à plusieurs factures fournisseurs actives — à résoudre manuellement (rejet des doublons) avant migration.', n;
  END IF;
END $$;

CREATE UNIQUE INDEX "supplier_invoices_one_active_per_file_key" ON "supplier_invoices"("companyId", "fileId") WHERE "fileId" IS NOT NULL AND "status" <> 'REJECTED';
