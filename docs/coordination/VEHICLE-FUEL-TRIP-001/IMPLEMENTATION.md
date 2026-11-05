# VEHICLE-FUEL-TRIP-001 — Dépense carburant préremplie selon le trajet (note de réalisation, 4 nov. 2026)

Branche locale `feat/vehicle-documents-ocr` (base `origin/main` `0e46b15`, PR #125 incluse), second commit après la
lecture des pièces (VEHICLE-DOC-OCR-001). **Rien n'est poussé, fusionné, déployé ni activé ; aucune donnée de production
n'est lue ni modifiée.** Rôles : Claude implémente, Codex relit (mission déposée dans `_COORDINATION`).

## Décisions (Nizar, 4 nov. 2026)

- Préremplissage direct au choix du trajet **et** encadré « Estimation du trajet » visible avec un bouton
  « Reprendre l'estimation » ; une saisie manuelle n'est jamais écrasée automatiquement ; note « Estimation trajet : … »
  ajoutée ; la dépense reste « À valider » (`PENDING`) et le ticket réel prime.
- Consommation (L/100 km) et carburant saisis dans l'encadré, **sans migration** (consommation retenue par véhicule
  dans le navigateur seulement).
- Codex relit ; même branche que la lecture des pièces pour un seul push d'essai.

## Complément du 4 nov. 2026 (soir) — chaque départ et chaque chantier

Demande de Nizar : le trajet se déduit du chantier. L'adresse vient de la fiche du chantier, le départ est le premier
jour planifié et le retour le dernier jour. Le chef d'équipe et le chauffeur sont identifiés, et le coût est calculé
pour chaque départ et chaque chantier.

- **Séjours planifiés** (`GET /api/trucks/[id]/fuel-estimate/stays`) :
  - jours de planning (refus exclus) des équipes qui avaient le camion ce jour-là, sur 60 jours passés et 60 jours à venir ;
  - regroupés par chantier et par équipe, puis découpés en suites de jours consécutifs : une suite = un départ et un retour ;
  - nom d'équipe, chef d'équipe (`Team.leaderId`) et chauffeur de la période du camion au jour du départ
    (`TruckAssignment.chauffeurId` ; à défaut de période, l'équipe et le chauffeur actuels du camion) ;
  - l'identifiant `chantier~équipe~départ` est recalculé côté serveur : un identifiant forgé ou périmé renvoie 404.
- **Estimation d'un séjour** (`?stayId=`) : aller siège → chantier le jour du départ, retour le jour de la fin
  (2 × itinéraire). La date de la dépense est le jour du départ ; aucun compteur n'est proposé. Des « déplacements sur
  place » facultatifs s'ajoutent aux kilomètres.
- **Longs trajets** : couloir échantillonné jusqu'à 160 points, interrogé en 4 requêtes de prix au plus (40 cercles chacune).
  - Prix retenu par défaut : la **médiane** de toutes les stations du couloir, plus représentative qu'une seule station.
    Elle est affichée avec le minimum et le maximum, et l'opérateur peut aussi choisir une station.
  - Le fournisseur n'est rempli que si une station est choisie.
- **Exemple réel** : chantier Groupe Peyrot, Montauban (4 → 6 nov. 2026), IGN et data.economie interrogés avec des
  coordonnées seules.
  - Itinéraire : 633,7 km par trajet, soit 1 267 km aller-retour.
  - Stations : 117 à 123 de gazole selon le rayon ; médiane 2,25 €/L, de 2,115 à 2,563 €/L.
  - Coût : 285 € à 10 L/100 km, 342 € à 12 L/100 km, **péages non compris**.
- **Défaut trouvé en recette et corrigé** : boucle de mises à jour (« Maximum update depth »), car le prix médian était
  recréé à chaque rendu. Le choix de prix est désormais mémorisé et la liste des champs préremplis n'est mise à jour
  qu'en cas de changement.
- **Recette locale** : chantier fictif à Montauban, équipe « BILEL A COMPO », chef et chauffeur fictifs.
  - Séjour proposé : « départ 04/11/2026, retour 06/11/2026 (3 jours) — BILEL A COMPO ».
  - Équipe, chef et chauffeur affichés.
  - 1 267 km, médiane de 117 stations, 270,82 € à 9,5 L/100 km.
  - Note de provenance avec le chantier et les dates ; aucune erreur de boucle.
- **Tests** : 22 / 22 (6 nouveaux) : séjours consécutifs ou interrompus, couverture du camion, chauffeur du jour du
  départ, médiane, liste des séjours avec équipe, chef et chauffeur, estimation d'un séjour, identifiants forgés 404,
  paramètres exclusifs 400, long trajet découpé en 4 requêtes.

## Drapeau

```
PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED=true   # absent = formulaire actuel strict
```

Il exige aussi `PLANIFICATOR_VEHICLES_V3_ENABLED=true`.

## Ce qui a été construit

| Fichier | Rôle |
|---------|------|
| `src/lib/vehicules/v3/fuel-estimate-domain.ts` | Règles pures : échantillonnage du tracé (≤ 30 points, rayon de couloir couvrant l'espacement), distance au tracé, classement des stations, litres = km × L/100 ÷ 100, montant au centime, note de provenance. |
| `src/lib/vehicules/v3/fuel-estimate-providers.ts` | Tracé IGN Géoplateforme (`bdtopo-valhalla`, gratuit, sans clé) et prix du flux instantané `prix-des-carburants-en-france-flux-instantane-v2` (data.economie.gouv.fr, gratuit, sans clé) : une requête par couloir (cercles en OU), corps borné, délai 6 s, lignes invalides écartées. |
| `src/lib/vehicules/v3/fuel-estimate-service.ts` | Drapeaux, session, droits relus sous verrou (`READING` : administrateurs, comme les coûts), trajet de l'entreprise de la session. Kilomètres : compteur du trajet clos, sinon aller-retour routier siège → chantier. Chantier sans coordonnées géocodé (IGN). Stations : couloir du trajet, sinon 3 km autour du chantier ou du siège. Cache par société (tracé 30 jours, prix 1 heure) et quota horaire partagé avec les imports (60 appels/h, catégorie `ROUTING` : la contrainte SQL n'admet que `ROUTING` et `GEOCODING`). Aucune écriture hors cache. |
| `src/app/api/trucks/[id]/fuel-estimate/route.ts` | `GET ?tripId=…&fuel=GAZOLE` ; en-têtes privés. |
| `src/components/vehicules/v3/vehicle-fuel-estimate-ui.ts`, `VehicleFuelEstimate.tsx` | Encadré : trajet, carburant, consommation, kilomètres et leur source, stations (prix, date du prix, écart au trajet, automate 24/24), avertissements prix ancien ou trajet ancien, calcul ; dernière réponse seulement. |
| `VehicleCostsPanel.tsx`, `vehicules/[id]/couts/page.tsx` | Préremplissage du formulaire existant (catégorie, date du trajet, compteur, fournisseur, montant, litres, notes) ; champ saisi = jamais réécrit automatiquement ; liste des champs préremplis « à vérifier ». Drapeau lu côté serveur. |

Le siège n'est connu que pour GALYA EVENTS (constante de la PR #125) : pour une autre société, ni itinéraire ni
stations depuis Montreuil.

## Preuves (locales)

| Contrôle | Résultat |
|----------|----------|
| `tests/vehicules/v3/fuel-estimate.test.ts` | **16 / 16** : couloir, distance, calcul et bornes, classement, note ; requêtes et contrôle des réponses IGN et prix (panne, réponse incohérente, lignes invalides ou hors couloir) ; service (drapeau et prototype éteints sans base ni réseau, compteur, aller-retour, géocodage, trajet libre, itinéraire en panne, prix en panne, quota atteint sans appel public, société sans siège, cache sans second appel, chef refusé, autre entreprise 404, paramètres invalides 400, aucune écriture métier, contrainte SQL du quota imitée) ; formulaire (valeurs proposées, pas d'écrasement, explicite, note remplacée, messages) |
| `npm run test:vehicules` | 219 + 205 + 193 + 9, tout vert (dont les 29 tests de lecture des pièces) |
| `npm run test:hr-documents` | 65 / 65 |
| `tsc --noEmit` | 52 diagnostics, tous antérieurs ; aucun dans les fichiers du lot |
| `npm run build` | réussi |
| Appels réels (coordonnées seules) | Montreuil → Paris centre : itinéraire 13,5 km en 0,17 s ; 8 stations gazole à moins de 1,25 km du tracé en 0,66 s, prix du jour 2,25 à 2,284 €/L |
| Navigateur local (base Docker jetable, société fictive à l'identifiant GALYA, camion GA-123-LY, chantier fictif Paris centre) | Trajet clos : 27 km compteur, 8 stations réelles, formulaire prérempli (FUEL, 03/11/2026, 120 027, 5,77 €, 2,565 L, note) ; fournisseur saisi à la main conservé, repris seulement sur « Reprendre l'estimation » ; dépense enregistrée `PENDING` avec sa note ; trajet en cours : 27 km aller-retour par l'itinéraire ; 375 px sans défilement horizontal |

**Défaut trouvé en recette et corrigé** : la catégorie de quota `FUEL_PRICES` violait la contrainte
`vehicle_import_provider_windows_provider_check` (erreur 500) ; les prix comptent désormais en `ROUTING`, la base
factice des tests imite la contrainte.

## Non vérifié / limites

- **Vercel non prouvé** : aucun essai déployé (durée, démarrage, sortie réseau depuis `fra1` vers l'IGN et data.economie).
- **Coût** : services publics gratuits, mais chaque estimation consomme du temps de fonction (≈ 1 s hors cache).
- **Prix du jour seulement** : l'API ne donne que le dernier prix connu, pas celui du jour du trajet (avertissement au-delà
  de 7 jours). L'historique n'existe qu'en archives annuelles, non intégrées.
- **Kilomètres** : un trajet en cours ou sans relevé est estimé en aller-retour siège → chantier, sans détour ni arrêts.
- **Consommation saisie** : aucune donnée véhicule ; la mémoire est propre au navigateur.
- **Quota** : les prix partagent le quota `ROUTING` des imports (60/h par société) ; une nouvelle catégorie exigerait
  une migration de la contrainte.
- **Pas d'imputation automatique** de la dépense au trajet : l'action « Remplacer les imputations » existante reste à faire à la main.
- Le préremplissage ne vide pas les champs si l'on revient à « Aucun trajet ».
- Péages non calculés : aucune source gratuite fiable n'est intégrée.
- Un séjour compte un seul aller et un seul retour. Une équipe qui rentre chaque soir d'un chantier proche est donc
  sous-estimée : on peut ajouter des « déplacements sur place ».
- Les prix du couloir sont limités à 100 stations par requête (les moins chères d'abord) : sur un couloir très dense, la
  médiane peut être légèrement basse.
- Le chauffeur affiché est celui de la période du camion. S'il n'est pas renseigné, l'écran l'indique, sans supposition.
- La lenteur de chargement observée pendant la recette venait du panneau de navigateur masqué (page en arrière-plan),
  pas de l'application.
- Revue Codex : mission déposée, résultat non reçu.

## Corrections R2 après revue Codex R1 (NO-GO), 4 nov. 2026 — non revues à ce jour

Plusieurs affirmations ci-dessus sont **remplacées** par cette section (géocodage, préremplissage des Notes, retour à
« Aucun », médiane « de toutes les stations », rayon variable).

- **Coordonnées seules (point 4)** : l'estimation ne géocode plus l'adresse d'un chantier. Sans coordonnées enregistrées :
  statut `NO_COORDINATES`, ni itinéraire ni couloir (stations autour du siège si connu) ; aucune adresse ni nom dans les
  requêtes publiques, aucun quota `GEOCODING` consommé.
- **Formulaire (point 5)** :
  - les champs écrits par l'estimation lui appartiennent tant qu'ils sont intacts ; tout changement de source, « Aucun »,
    chargement, erreur, absence de distance ou de prix, consommation effacée ou démontage retire ceux qui ne sont plus
    proposés (remise à la valeur d'ouverture) ;
  - un champ saisi ou modifié à la main n'est jamais réécrit ni effacé ;
  - la provenance n'est plus écrite dans Notes : elle est gardée à part et ajoutée aux notes à l'envoi, tant que le montant
    ou les litres estimés sont intacts, même si l'opérateur a tapé une note ;
  - montant estimé (euros) jamais écrit dans une dépense d'une autre devise, retiré si la devise change, envoi refusé s'il
    reste ; litres conservés ; aucune conversion. PENDING reste imposé côté serveur ; aucun compteur ni imputation.
- **Séjours (point 8)** :
  - convention d'attribution d'un jour à une seule période du camion : celle qui détient le camion à minuit (Paris),
    intervalle semi-ouvert [début, fin) ; à défaut, la première commencée dans la journée. Bascule en cours de journée :
    jour laissé à l'ancienne période et signalé ;
  - bornes canoniques : la liste lit le planning 62 jours de plus de chaque côté de aujourd'hui ±60 j, le détail la veille
    du départ et 62 jours après : un séjour estimable a les mêmes identifiant, dates et chauffeur dans les deux ;
  - séjour dont le départ ou le retour réel est inconnu, ou de plus de 62 jours : listé « non estimable » (option
    désactivée), refusé au détail (`STAY_INCOMPLETE` 409 ou `STAY_NOT_FOUND` 404) ;
  - planning lu dans l'ordre (date, id), 2 000 lignes au plus : au-delà, dernier jour écarté, liste « partielle »,
    séjours coupés non estimables ;
  - repli « équipe actuelle » signalé comme supposé ; chef affiché comme chef actuel ; noms bornés à la société.
- **Couloir et prix (point 7)** :
  - couloir de 2 km à vol d'oiseau du tracé, quelle que soit la longueur ; rayon de requête calculé pour couvrir cette
    largeur entre deux échantillons (≤ 20 km) ; filtre sur la distance exacte ;
  - tracé simplifié par Douglas-Peucker (≤ 1 000 points, tolérance rendue et ajoutée au filtre) au lieu de 200 points
    pris par indice ;
  - présenté comme « proximité approximative : accès et détour routier non vérifiés » ;
  - troncature à 100 stations par requête détectée (`total_count`) : statistiques marquées « échantillon », médiane non
    proposée par défaut, libellé et note qualifiés ; aucune pagination ni requête supplémentaire (quota inchangé).

### Limites restantes (R2)

- Le formulaire est testé par sa logique pure et un double de formulaire (`FakeForm`), plus un rendu statique ; aucune
  bibliothèque DOM (jsdom) n'est installée, donc pas de test d'interaction navigateur ni de recette navigateur R2.
- Diagnostic TypeScript non exécuté en R2 (commande refusée par les permissions de cette session) ; build non lancé.
- Proximité à vol d'oiseau seulement ; la médiane d'un couloir dense reste un échantillon (signalé), pas la vraie médiane.
- Les chantiers sans coordonnées n'ont plus d'itinéraire : à compléter dans leur fiche (choix de minimisation, à arbitrer).

### R3 — comportements conservateurs (prix, séjours), 4 nov. 2026

- Médiane d'un échantillon tronqué : **désactivée** (choix grisé, sans valeur chiffrée, explication « non
  représentatif ») ; refusée par `priceChoice` même forcée ; `estimateNote` lève `SAMPLED_MEDIAN`. Choisir une station
  reste possible.
- Prix : « prix indicatif publié par … le … » (station) et « prix médian indicatif des N stations lues … » ; distance
  toujours « à vol d'oiseau du tracé (accès non vérifié) », jamais « sur le tracé ».
- Séjours : `blocked` = `OUT_OF_RANGE` | `TOO_LONG` | `NO_HISTORY` | `HANDOVER` | `null`. Réaffectation du camion en
  cours de journée sur un jour du séjour, la veille ou le lendemain planifiés de la même équipe : **non estimable**
  (aucune attribution à minuit). Aucun historique d'affectation (repli équipe actuelle) : **non estimable**. Refus au
  détail : 409 `STAY_HANDOVER`, `STAY_NO_HISTORY`, `STAY_INCOMPLETE` (borne lue ou > 62 jours : aucun retour supposé).
  Chef libellé « chef d'équipe actuel (aujourd'hui, pas forcément pendant le séjour) ».
- Choix métier non tranchés (réserve conservée, à Nizar) : faut-il accepter une attribution conventionnelle des jours de
  réaffectation ou de l'équipe actuelle sans historique ? plafond de 62 jours ? historique daté des chefs ?

### R5 — décisions de séjour validées par Nizar, intégrées (4 nov. 2026, non commité)

- **Déplacements explicites** : `mode=ONE_ROUND_TRIP` (un aller-retour pour le séjour) ou `mode=DAILY` (un aller-retour
  par jour **planifié**, jours sans planning non comptés). Aucun mode par défaut ; sans mode, `km = null` et `missing`
  contient `MODE` (aucun montant proposé). Exemple : 100 km aller, 3 jours → 200 ou 600 km.
- **Coupures du planning** : suites du même chantier et de la même équipe reliées par une coupure de 7 jours au plus
  (`MAX_GAP_DAYS`) si, chaque jour de la coupure, le camion est à cette équipe (sans réaffectation en journée) et
  l'équipe n'est planifiée sur aucun autre chantier. Chaque coupure demande une décision (`STAY` sur place, `RETURN` au
  siège) identifiée par son premier ET dernier jour (`gapKey`). Coupure plus longue : séjours distincts. Un jour planifié
  n'appartient qu'à un séjour (pas de double compte dans le calcul ; les doublons de dépenses saisies à la main ne sont
  pas empêchés par cette liste).
- **Contexte canonique** : `PlannedStay.context` (empreinte des bornes, suites, coupures avec fin, jours, réaffectations,
  équipe, chauffeur, blocage). Toute décision exige `context` ; recalcul serveur différent → 409 `STAY_CONTEXT_CHANGED` ;
  l'encadré retire alors les choix et relit la liste.
- **Siège** : `depot=1` exigé pour tout kilométrage d'itinéraire (séjour ou trajet en cours), sinon `missing: [DEPOT]` ;
  compteur (trajet clos) inchangé, jamais multiplié. Km sur place toujours séparés.
- **Transfert en journée** : séjour `HANDOVER` refusé sans déclaration (409 `STAY_HANDOVER`) ; `handover=` égal aux
  jours exacts → estimation sous hypothèse (`travel.handoverDeclared`), sinon 409 `STAY_HANDOVER_MISMATCH`. Le GET
  n'écrit rien ; la déclaration n'est consignée que si une dépense est sauvegardée, dans la provenance des notes, par la
  commande existante (`vehicleExpenseCommand` : acteur, après-état). Historique d'affectation jamais modifié ; aucune
  nouvelle table, aucune migration.
- **Inchangé** : historique absent = refus (passé et futur) ; plafond 62 jours **civils** (coupures comprises) ; bornes
  non lues = refus ; chef = chef actuel étiqueté ; chauffeur de la période au départ, sans preuve de présence quotidienne.
