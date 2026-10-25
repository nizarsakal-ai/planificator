# SPEC-BILLING-C2 — Factures et paiements (Lot C2)

| Champ | Valeur |
|-------|--------|
| **Statut** | Implémenté localement — mission AI Team Lot C (25/10/2026), en revue |
| **Base** | SPEC-BILLING-B-MIN (Lot B : facture émise immuable, avoir total), SPEC-BILLING-C1 (centimes, drapeau, courrier simulé) |
| **Drapeau** | `BILLING_COMPLETE_ENABLED` ; relances : `BILLING_REMINDERS_ENABLED` |

## 1. Périmètre

Inclus : création manuelle d'une facture (brouillon, numéro provisoire) ou depuis un devis (C1), modification du brouillon, **émission** avec numérotation légale à l'émission (`FAC-AAAA-NNNN`, continue sans trou), contrôle des mentions obligatoires avant émission, envoi au client (courrier simulé), **paiements partiels** (`InvoicePayment`, verrou, plafonnement, annulation par contre-passation), statuts **PARTIAL / PAID**, **OVERDUE calculé** (jamais stocké), reste à payer, cartes « Total encaissé » / « Total dû », liste filtrable (recherche n°/client, statut, « En retard », client, période), détail avec barre de progression, relances J+30 / J+45 / J+60 après échéance (job idempotent, désactivé), PDF avec mentions légales.
Exclus (lots suivants) : acomptes (C3), avoirs partiels (C4), écritures comptables (C5). L'avoir total du Lot B reste disponible.

Drapeau OFF : `/factures` et `src/lib/actions/invoice.actions.ts` (Lot B) sont strictement inchangés ; les nouvelles routes (`/factures/[id]`, `/factures/nouvelle`, `/api/pdf/facture/*`, `/api/cron/billing-invoice-reminders`) répondent 404.

## 2. Modèle de données (migration additive `20261026010000_billing_c2_payments`)

- `InvoiceStatus` : + `PARTIAL` (partiellement payée).
- `PaymentMethod` : TRANSFER, CHECK, CASH, CARD, DIRECT_DEBIT, OTHER.
- `Invoice` : + `subject`, `reminderDue30SentAt`, `reminderDue45SentAt`, `reminderDue60SentAt` ; unique `(id, companyId)` (cible des FK composites) ; index `(companyId, status)`, `(companyId, issueDate)`, `(companyId, dueDate)`.
- `InvoicePayment` : `id`, `companyId`, `invoiceId`, `amountCents BigInt` (négatif pour une contre-passation), `method`, `paidAt` (date), `reference`, `notes`, `recordedById`, `reversesPaymentId` (unique : une contre-passation par paiement), `reversedAt`, `createdAt`. FK composite `(companyId, invoiceId) → invoices(companyId, id)` RESTRICT ; `onDelete: Restrict` partout.
- Base (SQL) :
  - `invoices_guard_issued` (Lot B) étendu : transitions ajoutées SENT→PARTIAL, PARTIAL→PAID, PARTIAL→CANCELLED (avoir total), et, **uniquement sous l'indicateur transactionnel `planificator.billing_payments = on` posé par le service de paiement**, PARTIAL→SENT, PAID→PARTIAL, PAID→SENT (contre-passation d'un paiement) ; `paidAt` posé en entrant dans PAID, effacé en le quittant, jamais modifié autrement. Toutes les règles existantes (création en brouillon, contenu figé, avoir total copie exacte) sont conservées : les 39 essais SQL du Lot B restent verts.
  - `invoice_payments_guard` : paiements **append-only** (aucun DELETE ; UPDATE limité à la pose unique de `reversedAt`) ; un paiement ne porte que sur une facture SENT/PARTIAL/PAID de kind INVOICE (et DEPOSIT au C3), jamais DRAFT/CANCELLED ni avoir ; montant ≠ 0 ; contre-passation = montant exactement opposé au paiement d'origine, même facture.
  - Contrôle différé `invoice_payments_total_check` : pour chaque facture, 0 ≤ Σ paiements ≤ `totalTTC` (plafond) et cohérence statut ↔ somme (PAID ⇔ somme = TTC, PARTIAL ⇔ 0 < somme < TTC, SENT ⇒ somme = 0) pour les factures émises de kind INVOICE.

## 3. Règles

1. **Brouillon** : numéro provisoire `PROV-AAAA-NNNN` ; en-tête et lignes modifiables (une transaction conditionnelle, Lot B `replaceDraftLinesCore` réutilisé pour les lignes + en-tête C2) ; suppression = abandon (CANCELLED, Lot B).
2. **Émission** (`issueInvoice`) : verrou `FOR UPDATE`, statut DRAFT et kind INVOICE requis ; contrôles bloquants : au moins une ligne, totaux recalculés en centimes depuis les lignes (corrigés si divergents), vendeur avec nom, adresse et SIRET, client avec nom ; date d'émission = date du jour (UTC) ; échéance = date d'émission + délai de paiement si absente ; **numéro légal attribué dans la même transaction** par le compteur `INVOICE` de l'année d'émission (`FOR UPDATE` implicite de l'upsert) ; un brouillon déjà numéroté `FAC-…` (créé par le chemin Lot B) conserve son numéro. Puis `status = SENT`, `sentAt`. Tout ou rien ; `flushDeferredConstraints`.
3. **Envoi** : courrier (facture + montant + échéance) via `BillingMailer`, journalisé ; renvoi possible ; n'influe pas sur le statut.
4. **Paiement** (`recordPayment`) : transaction avec `SET LOCAL planificator.billing_payments = on` ; verrou `FOR UPDATE` de la facture (société de session) ; statut SENT ou PARTIAL requis (PAID ⇒ « déjà soldée ») ; `reste = totalTTC − Σ paiements` **relu sous verrou** ; `0 < montant ≤ reste` (plafonnement : refus explicite) ; insertion du paiement ; statut PAID (+ `paidAt`) si reste − montant = 0, sinon PARTIAL ; audit.
5. **Contre-passation** (`reversePayment`) : paiement non déjà contre-passé et non contre-passation ; insertion d'un paiement de montant opposé référençant l'original, `reversedAt` posé ; statut recalculé (SENT si somme = 0, PARTIAL sinon ; PAID quitté ⇒ `paidAt` effacé). Jamais de suppression.
6. **OVERDUE** : calculé à la lecture : statut SENT ou PARTIAL et `dueDate < aujourd'hui`. Filtre « En retard ».
7. **Indicateurs** : Total encaissé = Σ paiements (toutes factures de la société, contre-passations incluses) ; Total dû = Σ restes des factures SENT/PARTIAL.
8. **Relances** J+30 / J+45 / J+60 après échéance pour SENT/PARTIAL avec e-mail client : job `/api/cron/billing-invoice-reminders` (Bearer, drapeaux), idempotent (`UPDATE … WHERE reminderDueXxSentAt IS NULL`) ; relance manuelle possible depuis le détail.
9. **PDF** : « FACTURE », numéro, dates d'émission et d'échéance, vendeur (SIREN/SIRET, TVA intracom., forme, capital, RCS), client (SIREN, TVA), lignes (désignation, qté, PU HT, remise, taux), récapitulatif par taux, totaux, conditions de paiement, pénalités de retard + indemnité forfaitaire 40 €, escompte, IBAN, autoliquidation le cas échéant, « Reste à payer » et paiements reçus ; brouillon marqué « (brouillon — non émise) ».
10. **Accès** : identique à C1 (ADMIN/SUPER_ADMIN, société de session).

## 4. Critères d'acceptation

- Émission : numéro `FAC-2026-0001`, `0002`… sans trou même si un autre brouillon est abandonné entre deux ; deux émissions concurrentes du même brouillon ⇒ une seule (verrou + conditionnel) ; contenu figé ensuite (Lot B).
- Paiements : deux paiements concurrents dépassant ensemble le reste ⇒ l'un refusé (plafond relu sous verrou), somme ≤ TTC ; PAID atteint exactement au centime ; contre-passation rétablit PARTIAL/SENT ; SQL direct : DELETE/UPDATE d'un paiement refusé ; paiement sur brouillon/avoir refusé ; dépassement refusé au COMMIT.
- OVERDUE calculé, jamais écrit ; relances : exécution répétée ⇒ un courrier par palier.
- Isolation : société B ne lit ni ne paie une facture de A ; `companyId` jamais pris du client.
- Drapeau OFF : `/factures` identique (fichier existant inchangé hors branche), actions Lot B inchangées (test existant « 4 transactions avec flush » toujours vert), `test:billing`, `test:billing:pg`, invariants SQL Lot B verts.
