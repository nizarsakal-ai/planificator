# SPEC-BILLING-C5 — Comptabilité : écritures automatiques, tableau de bord, TVA, FEC, banque, factures fournisseurs OCR (Lot C5)

| Champ | Valeur |
|-------|--------|
| **Statut** | Implémenté localement — mission AI Team Lot C (25/10/2026), en revue |
| **Base** | Moteur A1 (`createDraftEntry`/`postEntry`, écritures sourcées idempotentes, `runAccountingTransaction`), écrans A2 (`/comptabilite`), Lots C1–C4 |
| **Drapeaux** | `ACCOUNTING_MODULE_ENABLED` (module, garde A2 inchangée) ; `BILLING_COMPLETE_ENABLED` (pièces de facturation) ; `ACCOUNTING_AUTO_POSTING_ENABLED` (écritures automatiques à l'émission/paiement/validation, sinon génération manuelle idempotente) ; `BILLING_OCR_ENABLED` (appel réel de l'API Claude) |

## 1. Périmètre

Onglets ajoutés à la navigation A2 (en remplacement des entrées « à venir ») : **Tableau de bord**, **TVA**, **Export FEC**, **Banque et rapprochement**, **Factures fournisseurs** (OCR), **Écritures depuis les factures**. Rien n'écrit en comptabilité hors du moteur A1 (`createDraftEntry` + `postEntry`, sous `runAccountingTransaction`, contexte `requireAccountingAdmin`).
Exclus : multi-devise, Factur-X, télédéclaration, lettrage avancé, OFX (CSV uniquement), ancrage externe du chaînage.

## 2. Modèle (migration additive `20261026040000_accounting_c5`)

- `AccountingDocumentPosting` : lien pièce ↔ écriture : `companyId`, `sourceType` (INVOICE | CREDIT_NOTE | DEPOSIT | PAYMENT | SUPPLIER_INVOICE), `sourceId`, `sourceVersion` (1), `entryId` (FK composite journal_entries), unique `(companyId, sourceType, sourceId, sourceVersion)`.
- `Supplier` : `companyId`, `name`, `siret` (unique par société, nullable), `vatNumber`, `email`, `address`, `defaultExpenseAccountId` (FK composite accounting_accounts), `active`.
- `SupplierInvoice` : `companyId`, `supplierId?`, `supplierName`, `siret?`, `number`, `date`, `dueDate?`, `totalHTCents`, `vatCents`, `totalTTCCents` (BigInt), `vatRateBp?`, `expenseAccountId?`, `category` (texte : marchandises, services, location, déplacement, honoraires, entretien, autre), `status` PENDING | VALIDATED | REJECTED, `fileId?`, `ocrRaw Json?`, `ocrConfidence Json?`, `ocrProvider?`, `validatedAt?`, `validatedById?`, `paidAt?`, `notes?`, `createdById` ; unique `(companyId, supplierId, number)` partiel ; index statut/date.
- `SupplierInvoiceFile` : `companyId`, `sha256` (unique par société), `mime` (image/jpeg, image/png, image/webp, application/pdf), `size` (≤ 10 Mo), `data Bytes`, `originalName`. Stockage en base (aucun service tiers ; voir DECISIONS).
- `BankStatementImport` : `companyId`, `fileName`, `sha256` (unique par société : un relevé n'est importé qu'une fois), `rowCount`, `mapping Json`, `importedById`.
- `BankTransaction` : `companyId`, `importId`, `date`, `label`, `amountCents` (signé), `reference?`, `fingerprint` (sha256 de date|montant|libellé|référence, **unique par société** : aucune ligne en double entre deux imports), `status` PENDING | MATCHED | IGNORED, `matchedInvoiceId?`, `matchedPaymentId?`, `matchedSupplierInvoiceId?`, `matchedEntryId?`, `matchedAt?`, `notes?`.
- `VatDeclaration` : `companyId`, `periodStart`, `periodEnd` (dates), `basis` DEBITS | ENCAISSEMENTS, `collectedCents`, `deductibleCents`, `dueCents`, `details Json` (par taux), `status` DRAFT | DECLARED, `declaredAt?`, `createdById` ; unique `(companyId, periodStart, periodEnd)`.
- FK `onDelete: Restrict` partout ; tout porte `companyId`.

## 3. Règles

### 3.1 Écritures depuis les pièces (moteur A1)
- Comptes du référentiel A1 par numéro : 411000 clients, 706000 prestations (707000 si unité « marchandises » ? non : 706000 par défaut, paramétrable par ligne ultérieurement), 445710 TVA collectée, 512000 banque, 530000 caisse, 401000 fournisseurs, 445660 TVA déductible, 6xx charge (compte de charge choisi sur la facture fournisseur, défaut 606000). Référentiel initialisé si besoin (`ensureBaseReferential`), journaux VT/HA/BQ.
- **Facture émise / acompte émis** (journal VT, date = date d'émission) : D 411 TTC ; C 706 HT (par ligne positive, déductions d'acomptes en négatif ⇒ si HT total négatif, sens inversé) ; C 44571 TVA par taux (`vatRateBp` renseigné). **Avoir** (VT) : écriture inverse. **Paiement** (BQ, date = date du paiement) : D 512 (ou 530 si espèces) / C 411 ; contre-passation : inverse. **Facture fournisseur validée** (HA, date = date de la facture) : D 6xx HT, D 44566 TVA, C 401 TTC.
- Idempotence : `source = { type, id, version: 1 }` ; `createDraftEntry` renvoie l'existante si identique (`SOURCE_CONFLICT` sinon) ; `postEntry` idempotent ; `AccountingDocumentPosting` mémorise le lien. Exercice = celui contenant la date (sinon erreur « aucun exercice ouvert couvrant la date »).
- Déclenchement : bouton « Générer les écritures manquantes » (idempotent, par lot, rapport) et, si `ACCOUNTING_AUTO_POSTING_ENABLED=true`, génération automatique après émission/paiement/validation (hors transaction métier, erreurs journalisées sans bloquer la pièce).

### 3.2 Tableau de bord (société de session UNIQUEMENT — défaut n° 1 de PrintManager corrigé)
CA HT du mois et de l'année (factures et acomptes émis non annulés, avoirs déduits, par `issueDate`), factures impayées (nombre, reste dû), TVA à déclarer (collectée − déductible sur la période courante selon le régime), CA HT des 12 derniers mois (graphique), répartition des charges fournisseurs validées par catégorie (année).

### 3.3 TVA
Période [début, fin] ; base **débits** : TVA des factures/acomptes émis − avoirs par `issueDate` ; base **encaissements** : TVA incluse dans les paiements de la période, au prorata des bases par taux de la facture (TVA = paiement × TVA_taux / TTC) ; déductible : TVA des factures fournisseurs validées par date. Détail par taux. « Enregistrer la déclaration » fige les montants (DECLARED) ; une déclaration existante pour la même période est refusée.

### 3.4 Export FEC (art. A47 A-1 LPF)
Écritures **validées** de l'exercice choisi, 18 colonnes séparées par `|` : JournalCode, JournalLib, EcritureNum (numéro par journal), EcritureDate (AAAAMMJJ), CompteNum, CompteLib, CompAuxNum, CompAuxLib (vides), PieceRef (documentRef), PieceDate, EcritureLib, Debit, Credit (virgule décimale), EcritureLet, DateLet (vides), ValidDate, Montantdevise, Idevise (vides) ; ordre chronologique (date, journal, numéro, position) ; nom `SIRENFECAAAAMMJJ.txt` (SIREN dérivé du SIRET de la société ; `000000000` + avertissement si absent) ; encodage UTF-8, fin de ligne CRLF.

### 3.5 Banque et rapprochement
Import CSV générique : détection du séparateur, aperçu des 5 premières lignes, **mapping des colonnes** (date, libellé, montant OU débit/crédit, référence) choisi par l'utilisateur, formats de date JJ/MM/AAAA ou AAAA-MM-JJ, montants « 1 234,56 » ; relevé déjà importé (sha256) ⇒ refus ; ligne déjà présente (empreinte) ⇒ ignorée. Rapprochement automatique : pour chaque ligne PENDING créditrice, facture émise de la société dont le reste à payer = montant et (référence contient le numéro OU date à ± 10 jours de l'échéance/émission) ⇒ **enregistrement du paiement** (virement, date de l'opération) et MATCHED ; débit = facture fournisseur validée impayée de même TTC ⇒ marquée payée et MATCHED. Rapprochement manuel : choix d'une facture (paiement créé, plafond C2) ou d'une facture fournisseur, ou « ignorer ». Jamais deux paiements pour une même ligne (statut conditionnel).

### 3.6 Factures fournisseurs (OCR)
Téléversement (import image/PDF ou capture caméra via `<input capture>`) : type vérifié par **signature binaire** (JPEG/PNG/WebP/PDF), taille ≤ 10 Mo, sha256 (doublon ⇒ refus). Extraction via interface `SupplierOcrProvider` : implémentation `ClaudeSupplierOcrProvider` (API Anthropic, modèle configurable, appelée UNIQUEMENT si `BILLING_OCR_ENABLED=true` et clé présente ; jamais en test), sinon `DisabledOcrProvider` (saisie manuelle). Résultat analysé strictement (JSON, montants en centimes, SIRET 14 chiffres, date ISO, cohérence HT + TVA = TTC à ±2 c sinon « montants ajustés » signalé) avec scores de confiance par champ, affichés pour vérification. Liste : recherche fournisseur / n° / SIRET / SIREN, statut, compte de charge. **Validation** (transactionnelle, idempotente) : crée ou associe le fournisseur par SIRET (sinon par nom exact), fige la pièce (VALIDATED), génère l'écriture d'achat (3.1) ; rejet possible avec motif.

### 3.7 Accès et navigation
Garde A2 (`requireAccountingPage` / `requireAccountingAdmin`) sur tous les écrans et actions ; `AccountingNav` : les entrées réservées deviennent des liens ; `UPCOMING_MODULES` vidé.

## 4. Critères d'acceptation
- Écritures : facture multi-taux ⇒ écriture équilibrée validée (411 = Σ 706 + Σ 44571 par taux) ; régénération ⇒ aucune écriture en double ; avoir, acompte, paiement, contre-passation, facture fournisseur : équilibrées ; refus si aucun exercice ouvert.
- Tableau de bord : les montants de la société B n'apparaissent jamais pour A (test).
- TVA : débits vs encaissements sur un jeu de données connu, exact au centime ; déclaration figée.
- FEC : 18 colonnes, ordre chronologique, nom de fichier, uniquement les validées, débits = crédits.
- Banque : réimport du même fichier refusé, ligne en double ignorée, rapprochement auto crée un paiement unique, manuel plafonné.
- OCR : signature binaire fausse refusée, > 10 Mo refusé, doublon refusé, fournisseur créé une fois par SIRET, validation idempotente.
- Drapeaux OFF : module comptable 404 inchangé ; `test:accounting`, `test:accounting:pg` verts.
