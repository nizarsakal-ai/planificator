# Étude — facture électronique (réforme française 2026-2027)

*21/11/2026 — étude seule, aucun code. Sources officielles : economie.gouv.fr (« Tout savoir sur la facturation électronique »), impots.gouv.fr (FAQ « Je découvre la facturation électronique »), service-public.gouv.fr (actualité A15683).*

## 1. Ce que dit la réforme (état au 21/11/2026)

| Date | Obligation | Qui |
|---|---|---|
| **1er septembre 2026 (en vigueur)** | **Recevoir** les factures électroniques via une **plateforme agréée (PA)** | Toutes les entreprises assujetties à la TVA |
| 1er septembre 2026 (en vigueur) | Émettre + e-reporting | Grandes entreprises et ETI |
| **1er septembre 2027** | **Émettre** les factures électroniques via une PA + e-reporting | PME, TPE, micro-entreprises |

- Une « facture électronique » n'est **pas un PDF envoyé par e-mail** : c'est une facture **structurée** (Factur-X, UBL ou CII), transmise **par une PA** (émetteur → PA émettrice → PA réceptrice → client), avec transmission de données à l'administration.
- Quatre **nouvelles mentions obligatoires** (aux mêmes dates que l'émission) :
  1. SIREN du client ;
  2. adresse de livraison si elle diffère de l'adresse du client ;
  3. nature des opérations (livraison de biens, prestation de services, ou les deux) ;
  4. option pour le paiement de la TVA d'après les débits, le cas échéant.
- **E-reporting** : transmission des données des opérations hors champ de la facture électronique (B2C, international) et des données de paiement pour les prestations de services.

**Conséquence immédiate pour la société** (à confirmer selon sa taille — PME très probablement) : l'obligation de **réception** s'applique déjà. Il faut avoir **choisi une PA** pour recevoir les factures fournisseurs. Ce n'est pas un sujet Planificator : c'est un choix de prestataire, à faire maintenant.

## 2. Où en est Planificator

| Exigence | État | Commentaire |
|---|---|---|
| SIREN du client | **Partiel** | `Client.siret` existe (SIRET ou SIREN) et s'imprime ; le SIREN (9 premiers chiffres du SIRET) n'est pas encore une donnée contrôlée ni obligatoire à l'émission. |
| Adresse de livraison | **Fait** (ce lot) | Fiche client, facture, snapshot figé, PDF. |
| Nature des opérations | **Absent** | À ajouter : champ par facture (biens / services / mixte), avec une valeur par défaut au niveau de la société (« prestations de services » pour l'événementiel). |
| TVA sur les débits | **Absent** | Réglage société (oui/non) imprimé en mention. |
| Format structuré (Factur-X) | **Absent** | Le PDF actuel est un PDF simple, pas un PDF/A-3 avec XML CII embarqué. |
| Transmission via une PA | **Absent** | Aucun connecteur. |
| E-reporting | **Absent** | Dépend de la PA choisie. |
| Réception des factures fournisseurs | **Hors périmètre** | Le module « factures fournisseurs » importe des PDF ; la réception légale passera par la PA. |

Ce qui est déjà solide et réutilisable : snapshot immuable de chaque facture émise (données vendeur, acheteur, lignes, TVA), numérotation sans trou, avoirs liés, statuts de paiement : c'est exactement la matière d'un XML CII.

## 3. Options

### Option A — Mentions seulement (petit, recommandé tout de suite)
Ajouter les mentions 1, 3 et 4 (la 2 est faite) au formulaire, au snapshot et au PDF ; contrôle du SIREN client à l'émission (bloquant pour un client professionnel français).
- Coût : ~1 lot (migration de 2-3 colonnes, formulaire, snapshot, tests).
- Rend les factures **conformes sur le fond** ; ne règle pas la transmission.

### Option B — Planificator génère le Factur-X, la PA transmet (recommandé pour 2027)
Générer un **PDF/A-3 avec XML CII (profil EN 16931)** depuis le snapshot, puis le **déposer chez la PA** (API ou dépôt manuel).
- Avantages : pas de double saisie ; Planificator reste la source de vérité ; indépendant de la PA (format normé).
- Limites / risques :
  - PDF/A-3 : `@react-pdf/renderer` ne produit pas de PDF/A ; il faudra une étape de post-traitement (bibliothèque dédiée ou service de la PA qui accepte un CII seul). **Nouvelle dépendance probable** — à valider.
  - Validation : chaque facture doit passer les règles EN 16931 (schematron) ; tests de conformité à prévoir.
  - Statuts de cycle de vie retournés par la PA (déposée, rejetée, encaissée…) à rapatrier.

### Option C — Tout faire dans la PA
Ressaisir ou importer les factures dans l'outil de la PA. Simple à court terme, mais double saisie et risque d'écart entre Planificator et la facture légale. **Déconseillé**.

## 4. Recommandation

1. **Maintenant (hors code)** : choisir une plateforme agréée pour la **réception** (obligation en vigueur depuis le 1er septembre 2026). Privilégier une PA disposant d'une **API documentée de dépôt de factures Factur-X/CII** et de retour de statuts : c'est elle qui conditionne l'option B.
2. **Prochain lot Planificator** : option A (mentions SIREN, nature des opérations, TVA sur les débits).
3. **Avant mi-2027** : option B, une fois la PA choisie (son API fixe le contrat d'intégration). Estimation : 2 à 3 lots (XML CII depuis le snapshot + validation EN 16931 ; PDF/A-3 ; connecteur PA + statuts).

## 5. Informations manquantes (à fournir)
- Taille de la société au sens de la réforme (PME/ETI) : fixe la date d'émission (2026 déjà passée si ETI).
- PA choisie (ou présélection) et ses modalités d'API.
- Clients du secteur public : déjà soumis à Chorus Pro, à traiter dans le même connecteur.
