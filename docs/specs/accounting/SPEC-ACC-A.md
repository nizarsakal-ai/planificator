# SPEC-ACC-A — Socle comptable (Lot A)

| Champ | Valeur |
|-------|--------|
| **Statut** | Proposé |
| **ADR** | [ADR-PLAN-003](../../adr/ADR-PLAN-003-comptabilite-partie-double.md) |
| **Date** | 2026-10-25 |
| **Prérequis** | Lot 0 rebasé sur main ; Lot B minimal (protection des pièces) avant tout raccordement aux factures réelles |

## 1. Périmètre

Inclus : plan comptable par société (base PCG, paramétrable), journaux (VT ventes, HA achats, BQ banque, OD opérations diverses), exercices (ouverture, clôture), écritures et lignes en partie double, validation irréversible, contre-passation, balance et grand livre en lecture, comptes de TVA collectée/déductible par taux.
Exclus du Lot A : FEC, rapprochement bancaire, OCR, Factur-X/facture électronique, déclaration de TVA, multi-devise, interface de saisie avancée. Les données nécessaires aux exports futurs (dates, pièces, libellés, numéros) sont néanmoins stockées dès A.

## 2. Modèle (schéma cible A1)

- `AccountingAccount(companyId, id, number, label, class, active)` — unique `(companyId, number)`.
- `AccountingJournal(companyId, id, code, label, kind)` — unique `(companyId, code)`.
- `FiscalYear(companyId, id, startDate, endDate, status OPEN|CLOSING|CLOSED)` — pas de chevauchement par société.
- `JournalEntry(companyId, id, journalId, fiscalYearId, status DRAFT|VALIDATED, entryDate, documentDate, documentRef, label, number?, validatedAt?, validatedById?, sourceType?, sourceId?, sourceVersion?, sourceHash?, reversalOfId?, prevHash?, hash?)`.
- `JournalEntryLine(companyId, id, entryId, accountId, position, label, debitCents BigInt, creditCents BigInt, vatRateBp?)`.
- `AccountingSequence(companyId, journalId, fiscalYearId, lastNumber)` — compteur verrouillé.
- Contraintes : FK composites `(companyId, …)` ; `onDelete: Restrict` ; unique `(companyId, journalId, fiscalYearId, number)` ; unique `(companyId, sourceType, sourceId, sourceVersion)` ; CHECK `(debitCents > 0) <> (creditCents > 0)` et montants ≥ 0 ; déclencheurs : refus UPDATE/DELETE si l'écriture est VALIDATED, contrôle d'équilibre différé à la validation.

## 3. Règles métier

1. Brouillon libre (création/modification/suppression) ; validation = numéro + chaînage + horodatage, irréversible.
2. Validation refusée si : < 2 lignes, ligne débit ET crédit ou nulle, déséquilibre, compte inactif ou d'une autre société, exercice non OUVERT, date hors exercice.
3. Correction d'une écriture validée : contre-passation (lignes inversées, `reversalOfId`), puis nouvelle écriture.
4. Clôture : passage CLOSING (plus de validation sauf OD de clôture), puis CLOSED (plus aucune validation) ; corrections postérieures dans l'exercice suivant.
5. Idempotence : même source et même version ⇒ renvoie l'écriture existante si le contenu est identique, erreur sinon.
6. TVA : au Lot A, ventilation par taux sur comptes 44571x/44566x ; l'exigibilité (débits/encaissements) est un paramètre société, utilisée au lot TVA ultérieur.

## 4. Découpage A1

- **A1-a — validateur pur** (`validateEntry`) : entièrement déterministe, sans base ; calcul et contrôle en centimes.
- **A1-b — service transactionnel** (`postEntry`, `reverseEntry`) : transaction sérialisable ou verrous explicites ; compteur, chaînage, audit.
- **A1-c — migration** : schéma Prisma + SQL (déclencheurs, contraintes différées, FK composites), créée localement, appliquée seulement sur base de test.
- **A1-d — lectures** : balance et grand livre filtrés par société de session.
- Pas d'UI de saisie au Lot A1 ; page Comptabilité inchangée (flag OFF en production).

## 5. Critères d'acceptation

- Écriture déséquilibrée, ligne mixte, compte d'une autre société, exercice fermé : refusées (tests unitaires + PG).
- Écriture/lignes validées : UPDATE/DELETE refusés en base, même par requête SQL directe de l'application.
- Numérotation sans trou sous 20 validations concurrentes et après rollback forcé.
- Double soumission (même clé) : une seule écriture ; clé identique et contenu différent : erreur.
- Clôture concurrente d'une validation : état cohérent (soit validée avant clôture, soit refusée).
- Révocation de l'accès entre deux requêtes : opération refusée.
- Aucune lecture inter-société (balance, grand livre, export).
- Vérificateur de chaîne : détecte toute altération simulée.
- `test:accounting` et tests PG verts ; aucune nouvelle erreur `tsc` ; revue Codex GO.

## 6. Hors périmètre et dépendances

Lot B minimal (factures) : automate de statuts sans retour à DRAFT, émission transactionnelle verrouillée, avoirs, suppression des cascades sur pièces émises, audit. Lots ultérieurs : FEC, TVA, banque, OCR, facture électronique, interface.
