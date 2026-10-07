# Architecture — Vehicles V2

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **PROPOSÉ** (non validé). Suit les patrons vérifiés de Vehicles V0–V1C (`01-architecture/application-architecture.md`).

## Composants

```
UI /vehicules (V1C)  ──►  routes API  ──►  handlers à dépendances injectées  ──►  Prisma + SQL brut verrouillé
                          /api/trucks/[id]/trips          src/lib/vehicules/…
```

## Principes

1. Nouvelle logique dans `src/lib/vehicules/` (ex. `trips-api.ts`), handlers `{ auth, db }` comme `trucks-api.ts` ; routes minces dans `src/app/api/trucks/[id]/trips/`.
2. **Lot préalable V2-0 (refactor sans changement de comportement)** : `lockTrucks`, `requireAccess` et `TrucksApiError` ne sont pas exportés aujourd'hui (`trucks-api.ts`, l. 153, 244, 254). Les extraire dans un module partagé de `src/lib/vehicules/`, **sans modifier leur comportement**, prouvé par `npm run test:vehicules` inchangé et vert. Les nouveaux codes d'erreur vont dans un `TripsErrorCode` **séparé** (l'union `TrucksErrorCode` et sa table `ERRORS` ne sont pas touchées).
3. Le kilométrage courant du véhicule est écrit **uniquement** dans la transaction qui prend le verrou du véhicule.
4. Distance réelle = **fonction pure** `arrivée − départ`, testée ; jamais stockée comme source.
5. Aucun appel au géocodage ni calcul de distance géographique dans ce module (V2-MIL-008).
6. Erreurs typées nouvelles (ajoutées sans modifier les existantes) : voir `api-contract.md`.

## Changements encadrés sur du code V0–V1C (les seuls autorisés)

1. Extraction V2-0 ci-dessus.
2. Extension du garde de suppression d'employé (`employe-delete.core.ts` : `hasVehicleHistory` + regex P2003) pour couvrir `truck_trips` (impact E2, voir `spec.md`).

Toute autre modification de V0–V1C est hors périmètre.

## Dépendances

Lecture seule de `Worksite` (référence de contexte, filtrée par `companyId`), `Employee` (chauffeur, filtré par `companyId`), `Truck`.

## Risques

- Concurrence sur le kilométrage courant (deux trajets) → verrou + 409.
- Régression involontaire de V1B (archivage) → tests V0–V1C relancés à chaque PR.
- Dérive de périmètre vers l'entretien (V3) → refusée en revue.
