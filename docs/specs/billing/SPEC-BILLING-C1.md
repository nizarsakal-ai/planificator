# SPEC-BILLING-C1 — Devis complets (Lot C1)

| Champ | Valeur |
|-------|--------|
| **Statut** | Implémenté localement — mission AI Team Lot C (25/10/2026), en revue |
| **ADR** | ADR-PLAN-003 (montants en centimes, pièces immuables) ; SPEC-BILLING-B-MIN (Lot B) |
| **Drapeau** | `BILLING_COMPLETE_ENABLED=true` (serveur, OFF par défaut, lu en un seul endroit : `src/lib/billing/billing-feature-flag.ts`) |
| **Référence fonctionnelle** | PrintManager Pro (devis : liste, formulaire, PDF, envoi, signature en ligne, relances J+3/J+7/J+15, dupliquer, refuser, convertir) |

## 1. Périmètre

Inclus : devis multi-taux (TVA par ligne 0 / 2,1 / 5,5 / 10 / 20 %), remise par ligne et remise globale (pourcentage), totaux exacts en centimes, liste filtrable (n°/client, statut, client, période, montant TTC min/max), export CSV, import CSV, PDF avec mentions, envoi au client (courrier simulé derrière drapeau), lien de signature public (jeton ≥ 128 bits haché), relances J+3/J+7/J+15 (job idempotent, désactivé), dupliquer, refuser, expirer, accepter, convertir en facture (transactionnel, idempotent, statut CONVERTED), paramètres de facturation (mentions légales).
Exclus : paiement en ligne, signature graphique (dessin), facture électronique, multi-devise.

Drapeau OFF : aucune route `/devis*`, `/devis-signature/*`, `/api/pdf/devis/*`, `/api/cron/billing-*` n'est servie (404), aucune action exécutable, menu inchangé, comportement de production identique (tests de non-régression).

## 2. Modèle de données (migration additive `20261026000000_billing_c1_quotes`)

- `QuoteStatus` : + `CONVERTED` (ACCEPTED → CONVERTED à la conversion).
- `Quote` (colonnes ajoutées, toutes facultatives ou avec défaut) : `subject`, `globalDiscountBp` (0), `vatReverseCharge` (false), `acceptedAt`, `refusedAt`, `refusalReason`, `expiredAt`, `convertedAt`, `signerName`, `signedAt`, `signatureIpHash`, `signatureTokenHash` (unique), `signatureTokenExpiresAt`, `reminderJ3SentAt`, `reminderJ7SentAt`, `reminderJ15SentAt`, `importRef` (unique par société) ; index `(companyId, status)`, `(companyId, issueDate)`, unique `(id, companyId)`.
- `QuoteLine` : + `description`, `discountBp` (0).
- `Invoice` : + `globalDiscountBp` (0), `vatReverseCharge` (false) ; `InvoiceLine` : + `description`, `discountBp` (0) (copiés à la conversion ; utilisés par C2–C4).
- `Client` : + `siret`, `vatNumber` (mentions client).
- `BillingSettings` (1 par société) : `vatNumber`, `legalForm`, `shareCapital`, `rcs`, `iban`, `bic`, `quoteValidityDays` (30), `paymentTermsDays` (30), `latePenaltyText`, `quoteFooter`, `invoiceFooter`, `vatRegime` (DEBITS | ENCAISSEMENTS, pour C5), `defaultDepositBp` (3000, pour C3).
- `BillingMailLog` : trace de chaque courrier (`kind`, `to`, `subject`, `documentType`, `documentId`, `status` SIMULATED | SENT | FAILED, `error`) — jamais le corps.
- Compteur `DocumentCounter` type `INVOICE_DRAFT` : numéro provisoire `PROV-AAAA-NNNN` des factures issues d'une conversion (le numéro légal `FAC-AAAA-NNNN` est attribué à l'émission, C2). Le chemin d'émission du Lot B refuse un numéro provisoire (`PROVISIONAL_NUMBER_PREFIX`).
- Avoir total du Lot B : la copie exacte inclut désormais `description`, `discountBp`, `globalDiscountBp`, `vatReverseCharge` (service et fonction SQL `invoice_credit_matches`).

Les montants restent stockés en `Decimal(10,2)` (compatibilité production) ; tout calcul est fait en centimes `BigInt` (`src/lib/billing/money.ts`), conversions centralisées et testées.

## 3. Règles

1. **Montants** : quantité en centièmes (2 décimales), prix en centimes ; HT ligne = arrondi demi-supérieur(qté × PU / 100) ; remise ligne puis remise globale appliquées ligne par ligne (arrondi demi-supérieur au centime) ; TVA par ligne au taux de la ligne ; totaux = sommes ; récapitulatif par taux (base, TVA). Autoliquidation : TVA à 0 sur toutes les lignes, mention « Autoliquidation — TVA due par le preneur (art. 283-2 nonies du CGI) ».
2. **Automate** : DRAFT → SENT (envoi) ; SENT → ACCEPTED (signature en ligne ou acceptation manuelle) ; SENT → REFUSED ; DRAFT/SENT → EXPIRED (validité dépassée, job ou manuel) ; ACCEPTED → CONVERTED (conversion) ; DRAFT supprimable. Aucun retour arrière. Toute transition est conditionnée au statut lu (`UPDATE … WHERE status = attendu`) et tracée (`HistoryLog`).
3. **Modification** : lignes et en-tête modifiables uniquement en DRAFT (remplacement en une transaction conditionnelle).
4. **Envoi** : exige un e-mail client ; **validité métier non dépassée** (jour civil `validUntil` inclus, Europe/Paris — correctif P2-04, voir SPEC-BILLING-C6 §2) ; génère un jeton aléatoire de 256 bits (base64url), stocke `sha256(jeton)` et une expiration (fin de validité du devis, sinon +30 jours) ; le courrier (devis + lien de signature) passe par l'interface `BillingMailer` : implémentation Resend uniquement si `BILLING_MAIL_ENABLED=true`, sinon journalisée en SIMULATED. Renvoi possible en SENT (nouveau jeton).
5. **Signature publique** (`/devis-signature/[jeton]`, sans session) : le contenu du devis n'est affiché que si le jeton est valide, non expiré et le devis SENT ; sinon seul l'état (numéro, statut, société) est affiché ; acceptation = nom du signataire + case « lu et approuvé » ; refus = motif facultatif ; adresse IP stockée sous forme d'empreinte HMAC-SHA256 (secret serveur `AUTH_SECRET`), jamais en clair ; jeton inutilisable après usage (statut ≠ SENT) ; aucune autre donnée de la société exposée. L'acteur technique de la trace d'audit est le créateur du devis, le libellé précise « action du client via le lien public ».
6. **Relances** J+3 / J+7 / J+15 après `sentAt` pour les devis SENT non expirés : job `/api/cron/billing-quote-reminders` (Bearer `CRON_SECRET`), actif seulement si `BILLING_REMINDERS_ENABLED=true` ; **un seul courrier par devis et par exécution** (palier le plus élevé dû, paliers inférieurs marqués sautés) ; idempotent (`UPDATE … WHERE reminderJxSentAt IS NULL`) ; le lien de signature n'est régénéré que s'il est expiré ; expire au passage les devis SENT dont la validité est dépassée.
7. **Conversion** : verrou `FOR UPDATE` du devis, statut ACCEPTED requis ; si une facture (kind INVOICE) référence déjà le devis, elle est renvoyée (idempotence) ; sinon création d'une facture DRAFT (lignes copiées, totaux recalculés en centimes, remises, autoliquidation, échéance = émission + délai) et devis → CONVERTED ; tout ou rien.
8. **Import CSV** (séparateur `;` ou `,`, en-tête obligatoire) : colonnes `reference`, `chantier`, `designation`, `quantite`, `prix_unitaire_ht`, `tva` ; facultatives `unite`, `remise`, `description`, `validite`, `notes`, `objet`. Une référence = un devis DRAFT ; chantier résolu par nom exact (société de session) ; référence déjà importée ⇒ ignorée ; ligne invalide ⇒ devis entier rejeté ; maximum 500 lignes ; rapport (importés, ignorés, invalides). Cellules neutralisées (aucune formule).
9. **Export CSV** : filtres de la liste, `;`, virgule décimale, BOM, cellules protégées contre l'injection de formules.
10. **Accès** : ADMIN ou SUPER_ADMIN avec société active de session (même règle que `/factures`), `companyId` toujours issu de la session ; chantier, client et articles vérifiés dans la société.

## 4. Critères d'acceptation

- Totaux : vecteurs de test (multi-taux, remises, arrondis) exacts au centime ; `parse`/`format` sans flottant.
- Automate : transitions interdites refusées, concurrence simulée (statut changé entre lecture et écriture ⇒ refus sans écrasement), audit présent.
- Jeton : 43 caractères base64url, haché en base, expiré ou consommé ⇒ refus ; signature n'expose que le devis.
- Conversion : deux conversions concurrentes ⇒ une seule facture (test PG) ; devis d'une autre société ⇒ introuvable.
- Relances : exécution répétée du job ⇒ un seul courrier par palier (test PG).
- Isolation : aucune lecture ni écriture inter-sociétés (tests PG).
- Drapeau OFF : pages 404, actions refusées, menu identique, tests existants verts.
- `tsc` sans nouvelle erreur ; `next build` ; revue indépendante.
