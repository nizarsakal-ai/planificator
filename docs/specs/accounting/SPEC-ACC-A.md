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

## 3 bis. Précisions contractuelles (revue Codex du 25/10/2026)

**Immutabilité.** Déclencheurs sur `JournalEntryLine` refusant INSERT, UPDATE et DELETE dès que l'écriture parente — ancienne OU nouvelle en cas de changement de `entryId` — est VALIDATED ; sur `JournalEntry` : refus de toute modification d'une écriture VALIDATED et de la transition VALIDATED→DRAFT ; la transition DRAFT→VALIDATED n'est permise que par la fonction de validation (variable de session transactionnelle positionnée par le service). Le rôle SQL applicatif n'est pas propriétaire des tables et ne peut ni désactiver les déclencheurs ni exécuter de DDL. Tests SQL directs pour chaque cas.

**Exercices et clôture.** États OPEN → CLOSING → CLOSED, sans retour. En OPEN : validation de toute écriture datée dans l'exercice. En CLOSING : seules les écritures du journal OD portant `closingEntry = true`, validées par un ADMIN, sont permises (audit dédié). En CLOSED : aucune validation. La date comptable doit appartenir à l'exercice ; les numéros suivent l'ordre de validation (pas l'ordre des dates) ; une écriture datée dans une période antérieure de l'exercice OUVERT reste permise et est tracée. Validation et changement d'état de l'exercice prennent le même verrou (ligne `FiscalYear` FOR UPDATE) : une clôture concurrente attend ou fait échouer la validation, jamais d'état mixte.

**Idempotence.** Les quatre champs source sont tout-ou-rien (CHECK : tous NULL pour une écriture manuelle, tous renseignés sinon) ; l'unicité ne s'applique qu'aux écritures sourcées. La clé est réservée dès la création du brouillon. Empreinte = SHA-256 de la forme canonique v1 (ci-dessous) du contenu métier ; même clé + même empreinte ⇒ retour de l'existant ; empreinte différente ⇒ erreur `SOURCE_CONFLICT`, sans retry. Deux validations concurrentes de la même écriture : la seconde attend le verrou puis constate VALIDATED et renvoie l'état, sans second numéro.

**Montants et entrées.** Entrées API en chaînes décimales strictes (`^-?\d{1,13}(\.\d{1,2})?$`), converties en centimes BigInt ; plafond 10^15 centimes par ligne ; quantités en millièmes (BigInt), taux de TVA en points de base (entier) ; arrondi « demi supérieur » appliqué à la valeur absolue puis signe réappliqué ; les lignes stockent des montants positifs (débit OU crédit). Contre-passation = inversion exacte débit/crédit des lignes d'origine, sans recalcul.

**Chaînage.** Forme canonique v1 : objet JSON aux clés triées, encodage UTF-8 NFC, aucun espace ; dates ISO `YYYY-MM-DD`, horodatages UTC ISO à la seconde ; montants en chaînes de centimes ; `null` explicites ; lignes triées par `position` ; champs : version, companyId, journalId, fiscalYearId, number, entryDate, documentDate, documentRef, label, validatedAt, validatedById, sourceType/Id/Version, reversalOfId, lignes, prevHash. Tête de chaîne stockée dans `AccountingChainHead(companyId, journalId, lastEntryId, lastHash)` ; genesis `prevHash = sha256("GENESIS|" + companyId + "|" + journalId)` ; la chaîne traverse les exercices. Ordre de verrouillage unique : FiscalYear → AccountingSequence → AccountingChainHead ; compteur et tête créés atomiquement (INSERT … ON CONFLICT DO NOTHING puis SELECT FOR UPDATE) ; retry borné (3) sur échec de sérialisation. Un vecteur de test de référence (entrée canonique + hash attendu) est versionné avec A1-a.

**Contexte d'accès.** Le service reçoit le contexte autorisé (`companyId`, `userId`) issu de `requireAccountingAdmin` et le réutilise pour toute la transaction ; il revérifie dans la transaction que l'utilisateur dispose toujours d'une appartenance ADMIN active pour cette société (protection contre une révocation concurrente). Le repli silencieux de société du résolveur est interdit pour une saisie : si la société active diffère de celle de l'écran de saisie, l'opération est refusée.

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
- Révocation de l'accès entre deux requêtes ET pendant une transaction : opération refusée.
- Insertion, modification, suppression ou déplacement de lignes d'une écriture validée par SQL direct : refusés.
- Écriture incohérente de tenant (compte/journal d'une autre société) par SQL direct : refusée par les FK composites.
- Aucune lecture inter-société (balance, grand livre, export).
- Vérificateur de chaîne : détecte toute altération simulée.
- `test:accounting` et tests PG verts ; aucune nouvelle erreur `tsc` ; revue Codex GO.

## 6. Hors périmètre et dépendances

Lot B minimal (factures) : automate de statuts sans retour à DRAFT, émission transactionnelle verrouillée, avoirs, suppression des cascades sur pièces émises, audit. Lots ultérieurs : FEC, TVA, banque, OCR, facture électronique, interface.
