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
5. Audit `HistoryLog` (STATUS_CHANGED / CREATED) dans la même transaction que chaque changement.
6. Conservation : `onDelete: Restrict` depuis Company et Worksite ; suppression d'un chantier ou d'une société facturés refusée avec un message explicite.
7. Base : déclencheurs refusant toute modification de contenu, toute transition arrière et toute suppression d'une facture non DRAFT, ainsi que l'ajout/modification/suppression/déplacement de lignes d'une facture non DRAFT.

## Hors périmètre (lots suivants)
Avoirs partiels ; numéro attribué à l'émission plutôt qu'au brouillon ; calcul exact en centimes de `totals.ts` (toujours en `number`) ; devis (cycle différent) ; facture électronique.

## Vérifications
- `test:billing` (20 tests : automate, concurrence simulée, avoirs, isolation, contrôles de sources).
- PostgreSQL 17 temporaire : 52 migrations appliquées ; essais SQL des déclencheurs (interdits refusés, transitions permises acceptées, cascades refusées, avoir unique) ; essai de concurrence à deux sessions (émission en attente du verrou, appliquée aux lignes finales ; remplacement après émission : 0 ligne).
- Note : la garde de périmètre T-CORE-5 de test:chantiers (propre au lot LOT-1W-1a, comparée à un BASE_SHA figé) échoue déjà sur main (3 sous-tests) ; ce lot ajoute un sous-test du même type (schéma/migrations modifiés). À retirer ou mettre à jour par le propriétaire de LOT-1W-1a.
