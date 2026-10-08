# Vehicles V2 — Kilométrage

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

| Champ | Valeur |
|-------|--------|
| **Identifiant** | VEHICLES-V2-MIL |
| **État ES-001** | **PROPOSED** — spec rédigée à partir du besoin de l'utilisateur ; **non validée** |
| **Base** | `origin/main` e707381 (Vehicles V1C mergé) |
| **Prérequis verrouillés** | V0, V1A, V1B, V1B-db, V1C : **ne pas modifier** leur comportement, **sauf les deux changements encadrés listés dans « Impacts sur l'existant »** |
| **ADR requis** | Oui : introduction d'une nouvelle entité (trajet) = changement de persistance (`docs/adr/ADR-PLAN-NNN-*`) — **à rédiger avant la validation de la SPECIFICATION** (ARCHITECTURE précède SPECIFICATION) |

## Objectif

Permettre de suivre le kilométrage d'un véhicule : un kilométrage **courant** par véhicule, et des **trajets** qui peuvent enregistrer un kilométrage de départ et d'arrivée, dont on déduit la **distance réellement parcourue**.

## Constat d'audit qui structure la spec (VÉRIFIÉ)

- Le schéma `origin/main` ne contient **aucun** champ de kilométrage ni **aucune entité « trajet »** (recherche de `kilom`, `mileage`, `odometer`, `trajet`, `trip` : aucun résultat dans `src/` et `prisma/schema.prisma`).
- **V2 doit donc créer une nouvelle entité de trajet.** C'est la décision structurante n°1 (ADR).
- Le schéma contient des colonnes `latitude` (« prévu pour une carte future ») et un port de géocodage (`src/lib/geo/geocode.port.ts`) : une distance géographique est calculable, d'où V2-MIL-008.

## Dans le périmètre

Exigences `V2-MIL-001` à `V2-MIL-008` (voir `requirements.md`) et les exigences proposées `V2-MIL-P01…` à valider.

## Impacts sur l'existant (VÉRIFIÉS lors de la revue indépendante)

| # | Constat | Traitement dans cette spec | Changement de code V0–V1C |
|---|---------|----------------------------|---------------------------|
| E1 | `deleteChantier` (`src/lib/actions/chantier.actions.ts:472`) fait `prisma.worksite.delete` **sans gérer P2003** : une FK `RESTRICT` depuis un trajet bloquerait la suppression d'un chantier | FK `truck_trips.worksiteId` en **`ON DELETE SET NULL`** (le chantier n'est qu'un **contexte**, V2-MIL-007) : aucun changement de `deleteChantier` | **non** |
| E2 | `employe-delete.core.ts` (V1B-db) : `hasVehicleHistory` ne compte que `truckAssignment` et `truck`, et sa regex P2003 est `/truck_assignments\|trucks_chauffeurId/` : elle ne reconnaîtrait pas `truck_trips_*_fkey` | **Changement encadré n°2** : étendre `hasVehicleHistory` et la regex pour couvrir `truck_trips`, avec tests (suppression d'un employé ayant des trajets refusée proprement) | **oui** (changement encadré n°2) |
| E3 | `lockTrucks`, `requireAccess`, `TrucksApiError` ne sont **pas exportés** de `trucks-api.ts`; `TrucksErrorCode` est une union fermée | **Changement encadré n°1 (lot V2-0)** : extraction **sans changement de comportement** vers un module partagé, prouvée par `npm run test:vehicules` inchangé et vert. Les nouveaux codes sont dans un `TripsErrorCode` **séparé** (le contrat V0 n'est pas modifié) | **oui** (changement encadré n°1, sans effet de comportement) |

## Hors périmètre (explicite — ne pas ajouter)

- **Vidange / entretien, contrôle technique** (c'est V3, PROPOSED : idée seulement, non spécifié).
- **GPS, télématique, tracking temps réel**, import d'odomètre depuis un boîtier.
- Calcul d'itinéraire, estimation de distance chantier, alertes de seuil, coûts carburant.
- Toute modification de V0–V1C (archivage, historique d'affectation, `openForTruckId`, rôles existants).

## Décisions requises avant d'implémenter

| # | Décision | Options |
|---|----------|---------|
| D1 | Entité trajet : nom, cardinalité | `TruckTrip` (table `truck_trips`), un trajet = un véhicule, un chauffeur optionnel, un chantier optionnel |
| D2 | Lien kilométrage courant ↔ trajets | **Recommandé (a)** : tout relevé de trajet (départ ou arrivée) doit être **≥ au courant** ; s'il l'est, il devient le nouveau courant dans la **même transaction**, sous verrou véhicule ; si le courant est NULL, le premier relevé l'initialise. **Un relevé < courant est refusé** (409 `MILEAGE_REGRESSION`) : pas de saisie rétroactive en V2. (b) relevé indépendant : écarté (deuxième source de vérité) |
| D3 | Régression / relevé rétroactif | **Recommandé : refuser** tout relevé < courant (409 `MILEAGE_REGRESSION`), y compris un départ inférieur au courant. Correction d'une erreur de saisie ou saisie rétroactive = lot ultérieur avec motif tracé |
| D4 | Rôles | **Recommandé** : écriture = SUPER_ADMIN / ADMIN ; lecture = + TEAM_LEADER **limité au véhicule de son équipe** ; EMPLOYEE / CLIENT : aucun accès (saisie par le chauffeur = lot ultérieur). **Ne pas reproduire** l'écart TEAM_LEADER non restreint de V0–V1C (`03-security/rbac.md`) |
| D5 | Politique de FK du trajet | **Recommandé** : `Company`, `Truck`, `Employee` (chauffeur) en **RESTRICT** (cohérent V1B-db : historique jamais effacé silencieusement) ; `Worksite` en **SET NULL** (contexte seulement, voir E1) |
| D6 | Unité et type | entier en **kilomètres** (pas de décimales) ; plafond de plausibilité |

## Critère de sortie (MODULE CLOSED, rappel)

Tous les identifiants V2-MIL-* reliés à implémentation → test → preuve (`acceptance.md`), staging validé, autorisation utilisateur, production, smoke, PRR (ES-001 §25–§26).
