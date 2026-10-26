# SPEC-BILLING-C4 — Avoirs partiels et totaux (Lot C4)

| Champ | Valeur |
|-------|--------|
| **Statut** | Implémenté localement — mission AI Team Lot C (25/10/2026), en revue |
| **Base** | Lot B (avoir total, copie exacte, facture annulée), C2 (paiements, reste à payer), C3 (acomptes) |
| **Drapeau** | `BILLING_COMPLETE_ENABLED` |

## 1. Périmètre

Avoir **partiel** sur une facture émise (par lignes/quantités choisies ou par montant HT global), **plafonné au montant restant créditable** (TTC de la facture − Σ avoirs émis), série dédiée `AV-AAAA-NNNN` (compteur existant), lien FK vers la facture d'origine, impact sur le reste à payer (reste = TTC − paiements − avoirs partiels), état de la facture source recalculé (soldée si reste = 0). L'avoir **total** du Lot B reste disponible et compatible (facture annulée, copie exacte). Un avoir est une facture : numéroté à l'émission (émis immédiatement), immuable, PDF « AVOIR » avec référence à la facture d'origine et mention du motif.
Défauts PrintManager évités : avoirs non plafonnés, facture source inchangée.

## 2. Modèle (migration additive `20261026030000_billing_c4_credit_notes`)

- `InvoiceCreditScope` : TOTAL | PARTIAL ; `Invoice.creditScope InvoiceCreditScope?` (renseigné pour tout avoir ; les avoirs Lot B existants sont rétro-remplis TOTAL par la migration) ; `Invoice.creditReason String?`.
- `creditedInvoiceId` : l'index unique Lot B est remplacé par un index unique **partiel** (un seul avoir TOTAL par facture) + un index simple (plusieurs avoirs partiels). Relation Prisma `creditNotes Invoice[]`.
- Base : `invoices_credit_invariant` (Lot B) adapté : copie exacte exigée uniquement pour `creditScope = TOTAL` ; pour PARTIAL, contrôle différé `invoice_partial_credit_check` : Σ TTC des avoirs partiels émis ≤ TTC de la facture d'origine, origine émise (SENT/PARTIAL/PAID), même société/client/chantier, aucun avoir total coexistant ; un avoir partiel ne porte pas de lignes de montant négatif ni de quantité nulle.

## 3. Règles

1. **Création** (`createPartialCreditNote`) : verrou `FOR UPDATE` de la facture d'origine ; origine kind INVOICE uniquement (un acompte est déduit en totalité sur la facture de solde : seul l'avoir total du Lot B s'applique, tant qu'il n'est pas déduit sur une facture de solde émise), statut SENT/PARTIAL/PAID ; lignes = sélection de lignes d'origine avec quantité ≤ quantité d'origine (mêmes PU, remise, taux, désignation préfixée « Avoir — ») OU montant HT global ventilé par taux au prorata des bases (TVA au taux) ; plafond : TTC de l'avoir ≤ TTC d'origine − Σ avoirs partiels émis (refus explicite) ; numéro `AV-…` et émission (SENT) dans la même transaction ; motif obligatoire (≥ 3 caractères).
2. **Facture d'origine** : jamais modifiée (immuable) ; **plafond garanti en base pour tout événement** (paiement, contre-passation, avoir) par le contrôle central de l'origine — correctif P1-07, SPEC-BILLING-C6 §2 ; une PAID héritée sans paiement ne reçoit pas d'avoir partiel ; son **reste à payer** devient TTC − paiements − Σ avoirs partiels (fiche, liste, indicateurs, courriers, relances, PDF, plafond des paiements et contrôle différé) ; si reste = 0 et statut SENT/PARTIAL ⇒ passage à PAID (soldée par avoir). **Aucun trop-perçu par avoir** : l'avoir est plafonné au reste à payer (TTC − paiements − avoirs) ; pour créditer une somme déjà encaissée, contre-passer d'abord le paiement (remboursement effectif hors périmètre, documenté).
3. **Avoir total** : chemin Lot B conservé (`createCreditNoteCore`) ; refusé s'il existe déjà un avoir partiel (utiliser un avoir partiel du reste créditable).
4. **PDF** : « AVOIR n° … », « Avoir sur facture n° … du … », motif, lignes, récapitulatif TVA, montant à déduire/rembourser.
5. **Accès** : société de session uniquement.

## 4. Critères d'acceptation

- Avoir partiel par lignes (quantité réduite) et par montant : totaux exacts ; dépassement du plafond refusé ; deux avoirs concurrents dépassant ensemble le plafond ⇒ un refusé.
- Reste à payer et statut recalculés ; PAID atteint par avoir ; paiements inchangés.
- Avoir total après un avoir partiel refusé ; avoir total seul : comportement Lot B inchangé (39 essais SQL verts).
- SQL direct : avoir partiel au-delà du plafond refusé au COMMIT ; avoir d'une autre société refusé.
- Isolation société B ; drapeau OFF : rien de nouveau n'est servi.
