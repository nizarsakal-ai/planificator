-- Amendement SPEC-INVOICE-IMPORT-001 §9 — requêtes de vérification (LECTURE SEULE).
-- Remplacer :company par l'identifiant de la société (psql : \set company '''<id>''').
-- Montants en centimes. Le signe vient de la nature : facture +, avoir − (montants stockés positifs).

-- 1. Avant correction : répartition des pièces importées par nature et statut.
SELECT kind, status, count(*) AS pieces, sum("totalTTCCents") AS ttc_cents
FROM imported_invoices
WHERE "companyId" = :company
GROUP BY kind, status
ORDER BY kind, status;
-- Attendu avant : INVOICE/UNKNOWN 36 pièces 46393987 ; CREDIT_NOTE/UNKNOWN 2 pièces 1618480.

-- 2. Critère de recette, part « Importées » des cartes /factures (même règle que computeImportedTotals).
SELECT
  COALESCE(SUM(CASE WHEN kind = 'INVOICE' THEN "totalTTCCents" ELSE -"totalTTCCents" END) FILTER (WHERE status = 'PAID'), 0)                  AS encaisse_cents,
  COALESCE(SUM(CASE WHEN kind = 'INVOICE' THEN "totalTTCCents" ELSE -"totalTTCCents" END) FILTER (WHERE status IN ('ISSUED', 'OVERDUE')), 0) AS du_cents,
  count(*) FILTER (WHERE status IN ('UNKNOWN', 'PARTIALLY_PAID', 'CANCELLED'))                                                                 AS hors_totaux
FROM imported_invoices
WHERE "companyId" = :company;
-- Attendu après passage en « Payée » : encaisse_cents = 44775507 (447 755,07 €), du_cents = 0, hors_totaux = 0.

-- 3. Part « Planificator » (inchangée par ce correctif) : encaissé = somme des paiements ; dû = factures émises non soldées.
SELECT
  (SELECT COALESCE(SUM("amountCents"), 0) FROM invoice_payments WHERE "companyId" = :company) AS encaisse_cents,
  (SELECT count(*) FROM invoices WHERE "companyId" = :company AND status IN ('SENT', 'PARTIAL') AND kind <> 'CREDIT_NOTE') AS factures_ouvertes;
-- Attendu aujourd'hui : 0 et 0 (PROV-2026-0001 est un brouillon).

-- 4. Traçabilité après application : une ligne par pièce modifiée.
SELECT count(*) AS journalisees FROM history_logs
WHERE "companyId" = :company AND "entityType" = 'ImportedInvoice' AND action = 'STATUS_CHANGED';
-- Attendu : 38.
