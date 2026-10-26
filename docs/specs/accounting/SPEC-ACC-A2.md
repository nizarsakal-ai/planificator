# SPEC-ACC-A2 — Écrans du module Comptabilité (Lot A2)

| Champ | Valeur |
|-------|--------|
| **Statut** | Validé par Nizar le 25/10/2026 (périmètre tel quel ; accès : SUPER_ADMIN sur Galya, ADMIN pour les autres entreprises) |
| **ADR** | [ADR-PLAN-003](../../adr/ADR-PLAN-003-comptabilite-partie-double.md) |
| **Prérequis** | A1 en production (fait le 25/10/2026) ; activation en production seulement après validation du rôle applicatif distinct (`docs/runbooks/DB-APP-ROLE.md`) |

## 1. But

Rendre le moteur A1 utilisable par un administrateur de société, sur données saisies à la main, derrière le drapeau `ACCOUNTING_MODULE_ENABLED`. Aucune création automatique depuis les factures (lot ultérieur, non autorisé).

## 2. Écrans (sous `/comptabilite`, ADMIN de la société active, ou SUPER_ADMIN pour sa seule société de rattachement — voir §7)

| Écran | Contenu | Actions |
|---|---|---|
| Accueil | Exercice ouvert, nombre d'écritures (brouillon / validées), état de la chaîne par journal | Initialiser le référentiel (comptes PCG de base + journaux VT/HA/BQ/OD), ouvrir le premier exercice |
| Exercices | Liste, dates, état | Ouvrir un exercice ; passer en clôture ; clôturer (confirmation tapée) |
| Plan comptable | Comptes (numéro, libellé, actif) | Ajouter un compte ; activer / désactiver (un compte utilisé ne se supprime pas) |
| Écritures | Liste filtrable (exercice, journal, état, période) | Nouvelle écriture ; ouvrir le détail |
| Saisie | Journal, date, pièce, libellé, lignes (compte, libellé, débit, crédit, TVA) ; total débit/crédit et écart en direct | Enregistrer en brouillon ; enregistrer et valider |
| Détail | En-tête, lignes, numéro, empreinte, écriture contre-passée/contre-passante | Valider (brouillon) ; supprimer (brouillon) ; contre-passer (validée, exercice cible proposé) |
| Balance | Par exercice : comptes, total débit, total crédit, solde | Export CSV |
| Grand livre | Par compte et exercice : écritures validées, solde progressif | Export CSV |

Montants saisis en euros (chaîne décimale stricte, 2 décimales max), convertis en centimes par `parseAmountToCents` ; affichage `formatCents`. Interface en français, responsive, mêmes composants que les autres modules.

## 3. Serveur

- Server Actions minces : garde `requireAccountingAdmin()` (société de la session uniquement), validation zod, appel du service A1 dans `runAccountingTransaction`, erreurs `AccountingError` traduites en messages lisibles ; aucune écriture SQL hors service.
- Compléments de service (même règles qu'A1 : ADMIN / SUPER_ADMIN (société de rattachement) revérifié sous verrou, audit) : `deleteDraftEntry` (brouillon uniquement, refusé en base pour une écriture validée), `createAccount`, `setAccountActive`.
- Lectures : `trialBalance`, `generalLedger` existants ; liste paginée des écritures filtrée par `companyId` de session.
- Drapeau OFF ou rôle non autorisé : comportement actuel de la garde (page indisponible / 404), aucune action exécutable.

## 4. Hors périmètre

Création automatique d'écritures depuis factures/avoirs, TVA déclarative, FEC, banque/rapprochement, OCR, multi-devise, import.

## 5. Critères d'acceptation

- Parcours complet sur base de test : initialiser → ouvrir exercice → saisir, valider, contre-passer → balance équilibrée → clôturer.
- Un brouillon déséquilibré ne peut pas être validé (message clair) ; une écriture validée n'a ni bouton modifier ni supprimer.
- Aucune donnée d'une autre société visible ou modifiable (tests).
- Tests : actions (validation, refus), service PG (nouvelles fonctions, sous rôle non propriétaire), rendu des pages ; `next build` ; tsc sans nouvelle erreur ; revue de code indépendante.
- Déploiement avec drapeau OFF en production ; activation = décision séparée de Nizar après validation du rôle applicatif.

## 6. Modules suivants (place réservée)

La navigation du module réserve des entrées « À venir », visibles mais non cliquables, pour les lots ultérieurs : **Export FEC**, **TVA**, **Banque et rapprochement**, **Écritures automatiques depuis les factures**. L'architecture (sous-routes `/comptabilite/*`, services sous `src/lib/accounting/engine`, actions sous `src/lib/accounting/actions`) permet de les ajouter sans refonte.

## 7. Décisions de Nizar (25/10/2026)

1. Périmètre validé tel quel ; export FEC reporté à un lot ultérieur.
2. Laisser la place aux modules suivants dans la Comptabilité (§6).
3. Accès (précisé par Nizar) : « SUPER_ADMIN sur Galya et pour les autres entreprises ADMIN ».
   - SUPER_ADMIN : autorisé uniquement lorsque la société active de sa session est sa société de rattachement (`users.companyId`, Galya). Aucun accès aux comptabilités d'autres sociétés, aucun sélecteur de société.
   - ADMIN : société active de sa session uniquement (règle du Lot 0).
   - Revérifié à chaque écriture, sous verrou, dans la transaction (`assertStillAccountingAdmin`).
4. Saisie manuelle limitée aux exercices OUVERTS ; les écritures de clôture (exercice « En clôture ») ne sont pas saisissables en A2.
5. Exports CSV : « ; », virgule décimale, BOM UTF-8, cellules texte protégées contre l'injection de formules.
