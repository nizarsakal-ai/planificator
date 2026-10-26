# SPEC-BILLING-C3 — Acomptes (Lot C3)

| Champ | Valeur |
|-------|--------|
| **Statut** | Implémenté localement — mission AI Team Lot C (25/10/2026), en revue |
| **Base** | SPEC-BILLING-C1 (devis, conversion), SPEC-BILLING-C2 (émission numérotée, paiements) |
| **Drapeau** | `BILLING_COMPLETE_ENABLED` |

## 1. Périmètre

Factures d'acompte (`kind = DEPOSIT`) créées depuis un devis ACCEPTÉ ou CONVERTI (pourcentage ou montant TTC), plusieurs acomptes possibles, plafonnées au total TTC du devis, vraies factures (numérotées à l'émission, payables, immuables, avoir total possible), déduites automatiquement sur la facture de solde avec mention du numéro et de la date de chaque acompte, TVA de l'acompte aux taux des lignes du devis.
Défauts PrintManager évités : acompte créé depuis la facture finale et lié par texte, unique, non déduit.

## 2. Modèle (migration additive `20261026020000_billing_c3_deposits`)

- `Invoice` : + `depositBp Int?` (information : pourcentage demandé) ; `kind` DEPOSIT (ajouté en C2).
- `InvoiceLine` : + `deductsDepositId String?` (FK → `invoices.id`, RESTRICT) : ligne de déduction d'un acompte sur la facture de solde.
- `InvoiceDepositDeduction` : `companyId`, `finalInvoiceId`, `depositInvoiceId` (**unique** : un acompte n'est déduit qu'une fois), `amountTTCCents` ; FK composites `(companyId, …) → invoices(companyId, id)`, RESTRICT.
- Base : contrôle différé `invoice_deposits_ceiling_check` — pour un devis, Σ TTC des acomptes non annulés ≤ TTC du devis ; `invoice_deposit_deductions_guard` — la déduction référence un acompte émis (SENT/PARTIAL/PAID) de kind DEPOSIT, du même devis et de la même société que la facture de solde (kind INVOICE).

## 3. Règles

1. **Création d'un acompte** (`createDepositInvoice`) : devis ACCEPTED ou CONVERTED, de la société de session ; verrou `FOR UPDATE` du devis ; montant = pourcentage (points de base, 1..10000) du TTC du devis ou montant TTC saisi ; plafond : Σ acomptes non annulés (brouillons inclus) + nouvel acompte ≤ TTC du devis, sinon refus explicite ; refus si la facture de solde est déjà émise.
2. **Ventilation par taux** : la base HT du devis par taux (après remises) est multipliée par le pourcentage (ou par la part du montant TTC demandé), arrondi demi-supérieur au centime ; la TVA de chaque ligne d'acompte est calculée au taux de la ligne ; pour un montant TTC, la dernière ligne absorbe l'écart d'arrondi pour que le TTC de l'acompte soit exactement le montant demandé. Une ligne par taux : « Acompte de 30 % sur le devis DEV-2026-0001 (base TVA 20 %) ». Autoliquidation du devis respectée (TVA 0).
3. **Acompte = facture** : brouillon `PROV-…`, non modifiable ligne à ligne (recréer), émission par `issueInvoice` (numéro `FAC-…`, mentions), paiements, relances, PDF « FACTURE D'ACOMPTE » (mention du devis et « le solde sera facturé à l'issue des prestations »).
4. **Facture de solde** : la conversion (C1) ou l'action « Recalculer les déductions d'acomptes » ajoute, pour chaque acompte ÉMIS non annulé du devis, une ligne négative par taux « Déduction acompte FAC-… du JJ/MM/AAAA (TVA x %) » (quantité 1, prix HT négatif, même taux), et une ligne `InvoiceDepositDeduction`. Les lignes de déduction sont identifiées (`deductsDepositId`) et régénérées à chaque recalcul. Totaux recalculés en centimes (TTC du solde = TTC du devis − Σ acomptes).
5. **Émission de la facture de solde** (`issueInvoice`, kind INVOICE avec devis) : refus si un acompte du devis est encore en brouillon (émettre ou abandonner d'abord) ou si un acompte émis n'est pas déduit (recalculer d'abord) ; vérification que chaque déduction correspond exactement à l'acompte (montants par taux).
6. **Avoir sur un acompte** : avoir total (Lot B) possible tant que l'acompte n'est pas déduit sur une facture de solde émise ; sinon refus (cohérence : un avoir sur la facture de solde est alors la seule voie).
7. **PDF de solde** : bloc « Acomptes déduits » (numéro, date, montant TTC) et « Reste à payer ».

## 4. Critères d'acceptation

- 2 acomptes (30 % puis 50 %) sur un devis multi-taux : lignes par taux exactes, TVA exacte ; 3ᵉ acompte de 30 % refusé (plafond) ; acompte en montant TTC : TTC exact au centime.
- Facture de solde : lignes du devis + déductions, TTC = devis − acomptes ; émission refusée tant qu'un acompte est en brouillon ou non déduit ; après émission, contenu figé.
- Concurrence : deux créations d'acompte simultanées dépassant ensemble le plafond ⇒ une refusée (verrou + contrôle différé).
- Isolation : société B ne voit ni ne crée d'acompte sur un devis de A.
- Drapeau OFF : aucune route nouvelle ; Lot B et C1/C2 verts.
