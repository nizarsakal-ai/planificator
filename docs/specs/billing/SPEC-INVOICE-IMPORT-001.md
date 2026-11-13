# SPEC-INVOICE-IMPORT-001 / SPEC-BANK-VERIF-001 — Import des factures clients et avoirs (Tiime et autres logiciels) et vérification du compte bancaire

| Champ | Valeur |
|-------|--------|
| **Statut** | IN_BUILD → IN_REVIEW (implémentation locale, environnement de test uniquement) |
| **Décideur** | Nizar — validation obligatoire avant tout déploiement, import réel ou activation bancaire en production |
| **Base** | Lots C1–C5 (factures, avoirs, factures fournisseurs, OCR), garde facturation `requireBillingAdmin`, garde comptable A2 |
| **Migration** | `20261113120000_invoice_import_bank_verification` — additive, aucune table existante modifiée |
| **Drapeaux (fail-closed, valeur exacte `true`)** | `INVOICE_IMPORT_ENABLED` (en plus de `BILLING_COMPLETE_ENABLED`) ; `BANK_ACCOUNT_VERIFICATION_ENABLED` ; `BANK_VERIFICATION_PROVIDER` (`sandbox` hors production uniquement) ; OCR : `BILLING_OCR_ENABLED` existant |

## 1. Décisions d'architecture

### 1.1 Où vivent les factures importées ?

| Option | Avantages | Risques |
|---|---|---|
| A. Insérer dans `invoices` | Visible partout sans code | `worksiteId` obligatoire ; `@@unique(companyId, number)` partagé avec la numérotation légale `FAC-AAAA-NNNN` ; relances J+30/45/60 (envoi de courriels) ; auto-post comptable ; déclencheurs d'immuabilité ; paiements/rapprochement. Viole « aucun envoi, règlement ni mouvement comptable ». |
| **B. Table dédiée `imported_invoices` (retenue)** | Aucune interaction avec la numérotation, les relances, la comptabilité ; chantier facultatif ; identité métier propre | Deux listes à afficher (Factures + section « importées ») |

Factures **fournisseurs** : **hors import** (décision du 13/11/2026). Le parcours Comptabilité → Factures fournisseurs (« Scanner / importer une facture », OCR, validation manuelle, export comptable) est inchangé, aucun de ses fichiers n'est modifié. Une pièce reconnue comme facture fournisseur dans l'aperçu n'est jamais importée : l'utilisateur est orienté vers ce parcours.

### 1.2 Format Tiime

Aucun export Tiime réel et autorisé n'a été fourni et aucune documentation publique ne décrit les colonnes de l'export des factures. **Aucun format Tiime n'est donc codé en dur.** L'import Tiime utilise le même moteur que « Autre logiciel » : association des colonnes devinée à partir des en-têtes (synonymes français/anglais), toujours modifiable, et mémorisée par (société, logiciel, signature d'en-têtes) pour les imports suivants. **Prérequis de recette :** fournir un export Tiime réel anonymisé pour valider/ajuster les synonymes.

### 1.3 Vérification bancaire

Port `BankVerificationProvider` (démarrage → redirection vers le parcours du prestataire → confirmation **serveur à serveur**). Seul le service pose `VERIFIED`, après lecture du résultat chez le prestataire (jamais à partir des paramètres de l'URL de retour), avec IBAN identique et titulaire concordant avec la raison sociale. Contrainte SQL : `VERIFIED ⇒ verifiedAt ∧ provider`.
Adaptateurs : `sandbox` (tests et préproduction, refusé si `NODE_ENV=production` ou `VERCEL_ENV=production`). **Aucun adaptateur de prestataire réel n'est livré** : il exige un contrat (ex. Powens « Bank ID Check », Yousign Verify, Bridge…) et des identifiants. Sans prestataire configuré, l'écran affiche le blocage et ne propose pas de vérification.

## 2. Modèle

- `ImportedDocumentFile` : PDF/image originaux (≤ 10 Mo, type vérifié par signature binaire), unique `(companyId, sha256)`.
- `InvoiceImportBatch` : `PREVIEW → COMMITTED | CANCELLED`, `rows` (aperçu modifiable), `mapping`, `headerSignature`, `version` (verrou optimiste).
- `ImportedInvoice` : `kind` INVOICE | CREDIT_NOTE, numéro d'origine, `numberKey` (normalisé), `clientId` (FK composite société), `worksiteId?`, montants en centimes (contrainte HT + TVA = TTC), `status` normalisé + `sourceStatus` brut, `sourceSystem`, `sourceReference`, `creditedImportedInvoiceId?` / `creditedInvoiceId?` (exclusifs), `creditedNumber` brut, `fileId?`, `contentHash`. Identité : unique `(companyId, kind, numberKey)`.
- `CompanyBankAccount` (un par société) et `BankVerificationSession` (état aléatoire 32 octets, seul son SHA-256 est stocké, expiration 30 min, une seule session PENDING par compte).

## 3. Parcours d'import

1. **Factures → « Importer des factures »** (bouton unique). Choix du logiciel (Tiime / Autre logiciel + nom / PDF seuls), dépôt de fichiers : PDF, JPEG/PNG (scans), CSV, XLSX, ZIP (CSV/XLSX + PDF). Un fichier par requête (limite plateforme ≈ 4 Mo par requête) ; plusieurs fichiers alimentent le même lot.
2. **Analyse** (serveur) : ZIP lu en mémoire avec bornes (500 entrées, 10 Mo par entrée, 60 Mo décompressés, ZIP chiffrés/zip64 refusés) ; tableur → association des colonnes ; PDF → couche texte (`unpdf`) puis heuristiques ; PDF sans texte ou image → OCR (prestataire existant sous `BILLING_OCR_ENABLED`), sinon ligne à compléter à la main.
3. **Aperçu modifiable** : nature (facture client / avoir client / facture fournisseur), client ou fournisseur, numéro, date, échéance, HT/TVA/TTC, statut source, chantier (facultatif), facture d'origine d'un avoir, PDF associé. Indicateurs : PDF manquant, doublon dans le lot, déjà importé à l'identique (ignoré ; seul un PDF manquant est ajouté), **conflit** (même identité, contenu différent — la pièce existante n'est **jamais** écrasée), numéro déjà utilisé par une facture Planificator (bloquant), rapprochement client ambigu ou absent (bloquant tant que non confirmé), montants incohérents (bloquant).
4. **Validation** : transaction unique, tout ou rien, lot réclamé sous verrou optimiste avant toute écriture, analyse refaite dans la transaction. Conflit : la ligne doit être exclue ou marquée « Conserver l'existant » ; il n'existe aucun chemin de remplacement. Création de client uniquement sur choix explicite.
5. **Effets interdits** : aucun courriel, aucun paiement, aucune écriture comptable, aucune consommation de compteur de numérotation.

## 4. Sécurité

- Garde import : drapeaux → session → rôle ADMIN/SUPER_ADMIN → société active de session (`requireBillingAdmin`). Garde banque : drapeau → garde comptable A2 (`requireAccountingAdmin` / `requireAccountingPage` / `requireAccountingRoute`). `companyId` uniquement issu de la session ; tous les identifiants reçus (client, chantier, facture d'origine, fichier, lot) sont revérifiés dans la société.
- PDF privés : route authentifiée, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Disposition` avec nom assaini ; jamais dans le cache hors ligne.
- Contenu des documents traité comme donnée (prompt OCR), aucune donnée sensible journalisée (IBAN masqué).

## 5. Tests

Unitaires : ZIP (lecture, bornes, chiffré), tableurs, association de colonnes, normalisation (montants, dates, natures, statuts), analyse (doublons, conflits, ambiguïtés, pièces manquantes), IBAN (mod 97), service bancaire (succès, échec, état expiré/rejoué, titulaire discordant, IBAN modifié, prestataire absent/production).
PostgreSQL : export synthétique « façon Tiime » CSV + ZIP, « autre logiciel » XLSX avec association mémorisée, PDF scanné via OCR simulé, PDF texte, réimport sans doublon, conflit signalé et jamais écrasé, validations concurrentes, isolation société, facture fournisseur orientée (aucune écriture), invariance des tables de facturation / règlements / numérotation / courriers / comptabilité / fournisseurs / banque, vérification bancaire réussie et échouée.
Commandes : `npm run test:invoiceimport` et `npm run test:invoiceimport:pg` (base jetable migrée).

## 6. Hors périmètre

Factures et avoirs fournisseurs (parcours existant), lignes détaillées des factures importées, `.xls` ancien format, multi-devise, adaptateur de prestataire bancaire réel, ZIP > limite d'une requête (importer les PDF séparément).

## 7. Retour arrière

Drapeaux à OFF ⇒ fonctionnalités absentes. Migration additive : l'application précédente fonctionne sans la retirer ; ne pas supprimer les données importées pour revenir en arrière.

## 8. Points connus à arbitrer (Nizar)

1. **Export Tiime réel** : non fourni ; les synonymes d'en-têtes doivent être validés sur un export réel anonymisé avant tout import réel.
2. **Prestataire bancaire** : aucun adaptateur réel ; choix du prestataire, contrat et identifiants requis. Le simulateur ne doit être activé que sur un environnement dont la base n'est pas celle de production.
3. **Deux IBAN** : `billing_settings.iban` (imprimé sur les factures, inchangé) et `company_bank_accounts.iban` (compte vérifié). Un écart est signalé à l'écran ; l'unification toucherait le parcours Paramètres de facturation existant.
4. **Suppression d'un client ou d'un chantier portant des factures importées** : refusée par la contrainte en base ; les messages existants (« rattachement concurrent… », « factures liées… ») restent corrects mais ne nomment pas les factures importées. Les préciser modifierait `deleteClient` / la suppression de chantier.
5. **Liste Factures** : les pièces importées sont dans une liste dédiée (lien depuis Factures et depuis la carte client), hors totaux « encaissé / dû / en retard ».
6. **OCR** : un scan envoyé à l'import utilise le prestataire OCR existant (mêmes drapeau, modèle et sous-traitant que les factures fournisseurs) ; cet OCR lit l'émetteur et les montants, pas le client, qui reste à choisir.
