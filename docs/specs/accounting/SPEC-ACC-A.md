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

## 7. Notes d'implémentation A1 (v2, après revue Codex NO-GO du 25/10/2026)

**Frontière de privilèges.** L'indicateur de session `planificator.accounting_engine` n'est PAS une autorisation (tout rôle peut appeler `set_config`). Les mutations protégées (passage à VALIDATED, compteurs, têtes de chaîne, changement d'état d'exercice) exigent en plus `current_user` = propriétaire des tables, ce qui n'est possible pour le rôle applicatif qu'à travers deux fonctions `SECURITY DEFINER` à `search_path` figé (`pg_temp` en dernier) : `accounting_post_entry(company, entry, user)` et `accounting_advance_fiscal_year(company, fy, to, user)`. Elles numérotent, chaînent, calculent l'empreinte, auditent (`history_logs`) et exécutent immédiatement les contrôles différés.

**Défense en profondeur (même pour le propriétaire).** Au passage à VALIDATED : numéro = compteur courant, `prevEntryId/prevHash` = tête courante, empreinte recalculée en SQL (forme canonique v1 identique à `canonical.ts`, NFC via `normalize`). Tête : n'avance que vers l'écriture validée qui succède à l'ancienne tête. Contrôles différés : compteur = nombre = maximum des écritures validées (sans trou) ; tête = dernière écriture (aucun successeur) ; toute écriture validée est tête ou prédécesseur. Index uniques : un successeur par écriture, une seule origine par journal.

**Révocation.** Le service verrouille FOR SHARE, jusqu'au COMMIT, les lignes d'autorité (utilisateur, fiches salarié, sociétés concernées) puis les relit. Une révocation validée avant est vue ; une révocation lancée pendant attend la fin de l'opération. Ordre global : users → employees → companies → exercice → écriture → compteur → tête. Testé à deux sessions.

**Autorisation métier vs intégrité.** La base garantit l'intégrité du registre quel que soit l'appelant ; l'autorisation de l'utilisateur final (ADMIN actif de la société) reste vérifiée par le service applicatif (la base ne connaît pas l'utilisateur final).

**Prérequis de déploiement.** PostgreSQL ≥ 13 (`normalize`, `gen_random_uuid`), base UTF-8 ; rôle applicatif NON propriétaire des tables comptables, avec droits DML ; migrations exécutées par le rôle propriétaire. Option de durcissement : `REVOKE EXECUTE … FROM PUBLIC` puis `GRANT` au seul rôle applicatif.

**Verrous et erreurs transitoires.** `FOR NO KEY UPDATE` au lieu de `FOR UPDATE` (interblocage 40P01 avec les `FOR KEY SHARE` des FK ; sérialisation validation/clôture conservée et testée). READ COMMITTED + ordre unique : pas de 40001 attendu ; un 40P01 reste possible face à une transaction extérieure qui verrouille dans un autre ordre (ex. révocation touchant société puis utilisateur) : l'opération échoue proprement et peut être rejouée en entier par l'appelant. Aucun retry automatique en A1.

**Prisma.** Prisma 5.22 avale les erreurs levées au COMMIT des transactions interactives (testé). Les fonctions SQL exécutent leurs contrôles différés avant de rendre la main ; `flushDeferredConstraints` (`src/lib/deferred-constraints.ts`) sert aux autres transactions (Lot B v4). Une transaction qui compose A1 et B doit faire son propre flush final et ne plus écrire ensuite.

**Contre-passation.** Miroir contrôlé par le service (erreur typée) et par la base. `reverseEntry(…, { entryDate, fiscalYearId? })` : après clôture, la correction se passe dans l'exercice suivant (testé).

**Idempotence.** Verrou consultatif transactionnel par clé source : deux créations concurrentes identiques renvoient la même écriture ; divergentes : une réussit, l'autre `SOURCE_CONFLICT` (testé). À la validation, l'empreinte du contenu courant d'un brouillon sourcé doit égaler `sourceHash` (`SOURCE_HASH_MISMATCH` sinon). Le gel en base des brouillons sourcés est reporté au lot de raccordement.

**Vérificateur.** Parcours depuis la tête avec recalcul, détection de cycle, arrivée au genesis, exhaustivité (toutes les écritures validées du journal atteintes), numérotation 1..n par exercice, absence de tête avec écritures validées.

**Montants.** Les lignes portent des montants positifs (débit OU crédit) : l'analyseur refuse le signe (écart assumé au motif signé du §3 bis, qui concerne les entrées API ultérieures). Partie entière ≤ 13 chiffres, soit au plus 999 999 999 999 999 centimes, sous le plafond SQL de 10^15.
