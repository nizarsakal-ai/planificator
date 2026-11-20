# SPEC-PDF-DESIGN-001 — Modèles de design des PDF (devis, factures, acomptes, avoirs)

| Champ | Valeur |
|-------|--------|
| **Statut** | IN_REVIEW |
| **Date** | 20/11/2026 |
| **Décideur** | Nizar |
| **Migration** | `20261120090000_billing_pdf_design` — additive (colonnes + 2 énumérations + CHECK des couleurs) |

## 1. Décisions (validées le 20/11/2026)
- **Portée** : tous les documents du gabarit commun (devis, factures, acomptes, avoirs).
- **Choix** : réglage par défaut de la société (Factures → Paramètres → « Apparence des PDF ») + choix propre à chaque **brouillon** (carte « Apparence du PDF » du détail).
- **Couleurs** : 2 par design — principale (bandeaux, titres) et secondaire (totaux, accents) ; 6 palettes prêtes ou code libre.

## 2. Contenu d'un design (`src/lib/billing/pdf/design.ts`)
- **Modèle** : Classique (rendu historique, défaut), Moderne (logo à gauche, client en haut à droite, en-tête de tableau en bandeau arrondi, total TTC en pastille, tampon), Bandeau (en-tête plein en couleur), Épuré (noir et blanc, couleur sur filets et total).
- **Format** : Complet ; Rapide (désignation / TVA / montant HT) **uniquement si toutes les lignes ont une quantité de 1 sans remise** — sinon repli automatique sur Complet (quantité et prix unitaire restent toujours déductibles, art. 242 nonies A CGI).
- **Options** : SIREN/SIRET et n° de TVA du client (affichés par défaut) ; encadré « Coordonnées bancaires » (IBAN/BIC des paramètres ; remplace la mention de virement, jamais de doublon).
- **Lisibilité** : contraste WCAG ≥ 4,5 exigé (texte blanc sur la principale, secondaire sur fond blanc), contrôlé à la saisie et côté serveur ; format `#rrggbb` contrôlé aussi en base.

## 3. Résolution et figement
- Brouillon : choix du document (tout ou rien) ?? réglage de la société ?? Classique historique.
- **Facture émise** : design et coordonnées bancaires figés dans `invoice_document_snapshots.document` (immuable). Snapshot antérieur sans design ⇒ Classique.
- **Devis envoyé** : design effectif écrit sur le devis à l'envoi (`transitionQuoteCore`). Devis envoyé avant ⇒ Classique.
- Conversion devis → facture : la facture de solde reprend le design du devis (devis sans design ⇒ réglage de la société).
- Limite connue : un devis n'a pas de snapshot documentaire ; l'encadré bancaire d'un devis déjà envoyé affiche l'IBAN actuel des paramètres.
- Tampon « Payée » / « Annulée » (modèles récents) : calculé à chaque rendu depuis le statut, jamais figé ; jamais sur un avoir ni sur Classique.

## 4. Hors périmètre (à arbitrer)
- Facture électronique (Factur-X / plateforme agréée, réforme 2026) : chantier distinct.
- Langue du document (anglais) : toutes les mentions légales à traduire et valider.
- Adresse de livraison : nouveau champ client et mention à concevoir.
