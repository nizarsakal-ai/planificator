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
- Chargement initial de l'onglet parfois lent en développement (trajets affichés après plusieurs secondes) : constaté
  sur le panneau existant, cause non analysée.
- Revue Codex : mission déposée, résultat non reçu.
