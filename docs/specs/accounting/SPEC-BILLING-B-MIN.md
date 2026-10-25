# SPEC-BILLING-B-MIN — Protection des pièces de facturation (Lot B minimal)

| Champ | Valeur |
|-------|--------|
| **Statut** | Implémenté localement — en revue |
| **ADR** | ADR-PLAN-003 (branche feat/accounting-foundation-rebased) §10 |
| **Date** | 2026-10-25 |

## Objet
Rendre les factures émises fiables avant tout raccordement comptable : correction des défauts P1 de la revue Codex du 25/10/2026 (retour à DRAFT, course brouillon/émission, annulation sans avoir, suppression en cascade).

## Règles
1. Automate : DRAFT → SENT (émission) ; SENT → PAID ; DRAFT → CANCELLED (brouillon abandonné, conservé). Aucun retour à DRAFT ; statut validé à l'exécution (`parseRequestedStatus`).
2. Facture émise (SENT/PAID) : annulation uniquement par **avoir total** (`createCreditNote`) — numéro `AV-AAAA-NNNN`, copie exacte des lignes et montants, `kind = CREDIT_NOTE`, `creditedInvoiceId` unique (un avoir par facture), émis aussitôt ; la facture passe à CANCELLED dans la même transaction.
3. Toute écriture est conditionnée au statut lu (`UPDATE … WHERE status = attendu`) ; en cas de changement concurrent : refus « modifiée entre-temps », rien n'est écrasé.
4. Lignes d'un brouillon : contrôle DRAFT et remplacement dans une seule transaction conditionnelle ; une émission concurrente attend le verrou et porte sur les lignes finales.
5. Audit `HistoryLog` dans la même transaction : création de facture (CREATED), remplacement des lignes d'un brouillon (UPDATED), émission/paiement/abandon (STATUS_CHANGED), avoir (STATUS_CHANGED sur la facture + CREATED sur l'avoir).
6. Conservation : `onDelete: Restrict` depuis Company et Worksite ; suppression d'un chantier ou d'une société facturés refusée avec un message explicite.
7. Base (migration billing_lot_b_minimal, v2) :
   - création obligatoirement en DRAFT ; id, createdAt, kind et companyId immuables ; CHECK kind ↔ creditedInvoiceId ;
   - hors DRAFT : seules SENT→PAID et SENT/PAID→CANCELLED (factures) ; contenu et sentAt figés ; paidAt posé uniquement au passage à PAID ; émission exige sentAt ;
   - lignes : toute mutation prend un verrou partagé sur la ou les factures concernées (ordre déterministe) puis refuse si l'une n'est pas DRAFT — sérialisé avec l'émission ;
   - invariant différé (COMMIT) : une facture émise annulée possède son avoir total émis, de même société et mêmes montants ; un avoir référence une facture annulée de même société, mêmes montants, et est émis.

## Hors périmètre (lots suivants)
Avoirs partiels ; numéro attribué à l'émission plutôt qu'au brouillon ; calcul exact en centimes de `totals.ts` (toujours en `number`) ; devis (cycle différent) ; facture électronique.

## Vérifications (v2)
- `test:billing` (20 tests unitaires : automate, concurrence simulée, avoirs, isolation, audit, contrôles de sources) — transaction simulée, ne remplace pas les essais PostgreSQL.
- `tests/billing/pg/lot-b-invariants.sql` : 29 essais PostgreSQL avec assertions (contraintes différées forcées par SET CONSTRAINTS IMMEDIATE).
- `tests/billing/pg/lot-b-concurrency.sh` : 3 scénarios à deux sessions (ligne puis émission ; émission puis ligne ; deux avoirs concurrents).
- Note : la garde de périmètre T-CORE-5 de test:chantiers (propre au lot LOT-1W-1a, comparée à un BASE_SHA figé) échoue déjà sur main (3 sous-tests) ; ce lot ajoute un sous-test du même type (schéma/migrations modifiés). À retirer ou mettre à jour par le propriétaire de LOT-1W-1a.
