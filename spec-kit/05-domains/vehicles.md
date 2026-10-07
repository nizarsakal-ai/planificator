# Domaine — Vehicles

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** sur `origin/main` e707381 (schéma, migrations, `src/lib/vehicules/`, `src/app/api/trucks/`, `tests/vehicules/`). Premier exemple de **spec vivante** du kit.

> **Verrou** : V0 à V1C sont livrés dans `main`. Ne pas y retoucher sans spec. Une demande « implémente Vehicles V2 » ne doit **jamais** déclencher d'ajout de vidange, contrôle technique, GPS ou télématique.

## Vocabulaire

Le domaine métier s'appelle « Véhicules » ; le code l'appelle **`Truck`** (modèle `Truck`, table `trucks`, API `/api/trucks`, page `/vehicules`, dossier `src/lib/vehicules`). Ne pas renommer : un renommage est un changement structurant (ADR).

## État des modules

| Lot | Contenu | Commit (origin/main) | État ES-001 |
|-----|---------|----------------------|----------------------|
| **V0** — durcissement API | rôle, entreprise de session obligatoire, validation stricte, erreurs distinctes | `b37cc8d` fix(vehicles): harden truck API access and validation | IN_REVIEW (merge seul, `main`) ; RELEASED / CLOSED : **À CONFIRMER** |
| **V1A** — socle données | `active`, `archivedAt`, `reason`, `openForTruckId` + trigger, FK `companyId` RESTRICT, CHECK « archivé ⇒ sans équipe ni chauffeur » | `927084a` | IN_REVIEW (merge seul). Migration `20261006120000_vehicles_v1a_foundation`. RELEASED / CLOSED : À CONFIRMER |
| **V1B** — archivage + historique | périodes d'affectation, archivage atomique, verrous, DELETE = archivage | `a6eff84` | IN_REVIEW (merge seul). RELEASED / CLOSED : À CONFIRMER |
| **V1B-db** — intégrité historique | BACKFILL `reason`, FK RESTRICT, CHECK chronologie et motif | `b57a017` | IN_REVIEW (merge seul). Migration `20261006180000_vehicles_v1b_db_integrity`. RELEASED / CLOSED : À CONFIRMER |
| **V1C** — identité + UI flotte | colonne `modele`, page Véhicules (liste, fiche, formulaire, historique, stats) | `e707381` | IN_REVIEW (merge seul). Migration `20261006220000_vehicles_v1c_modele`. RELEASED / CLOSED : À CONFIRMER |
| **V2** — kilométrage | voir `08-specs/active/vehicles-v2-mileage/` | — | **PROPOSED** (spec rédigée dans ce kit, non validée) |
| **V3** — entretien / CT | non spécifié | — | **PROPOSED** (idée seulement, aucune spec : ne pas commencer) |

> « COMPLETE », « PLANNED » et « mergé » ne sont pas des états ES-001. Un merge seul laisse le lot IN_REVIEW (PLAN-GOVERNANCE-001). Passer à RELEASED quand le déploiement est prouvé, à CLOSED après la PRR et les critères ES-001 §26.

## Modèle de données (extrait vérifié)

`Truck` : `id`, `matricule` (unique par entreprise), `marque?`, `modele?` (max 100, V1C), `companyId`, `teamId?` (unique : un véhicule par équipe), `chauffeurId?`, `active` (défaut true), `archivedAt?`.
`TruckAssignment` : `truckId`, `chauffeurId?`, `teamId?`, `companyId`, `startedAt`, `endedAt?`, `reason?` (jamais NULL en base après V1B-db), `openForTruckId?` (**unique, écrit uniquement par le trigger**).
`TruckAssignmentReason` : `CREATED`, `REASSIGNED`, `DISPLACED`, `ARCHIVED`, `RESTORED`, `BACKFILL`.

## Invariants (voir `04-database/integrity-rules.md`)

Une période ouverte max par véhicule ; archivé ⇒ sans équipe ni chauffeur ; chronologie ; motif obligatoire ; historique jamais effacé (RESTRICT) ; nouvelles affectations refusées vers véhicule archivé, équipe archivée, chauffeur inactif ; relations legacy jamais réécrites.

## API

| Route | Méthode | Rôles | Handler |
|-------|---------|-------|---------|
| `/api/trucks` | GET | SUPER_ADMIN, ADMIN, TEAM_LEADER | `handleTrucksGet` |
| `/api/trucks` | POST | SUPER_ADMIN, ADMIN, TEAM_LEADER | `handleTrucksPost` |
| `/api/trucks/[id]` | PATCH | SUPER_ADMIN, ADMIN, TEAM_LEADER | `handleTruckPatch` |
| `/api/trucks/[id]` | DELETE (= archivage) | SUPER_ADMIN, ADMIN | `handleTruckDelete` |
| `/api/trucks/[id]/archive` | POST (idempotent) | SUPER_ADMIN, ADMIN | `handleTruckArchive` |
| `/api/trucks/[id]/restore` | POST | SUPER_ADMIN, ADMIN | `handleTruckRestore` |

Codes d'erreur typés : liste complète dans `src/lib/vehicules/trucks-api.ts:43-60`. Page `/vehicules` : ADMIN / SUPER_ADMIN seulement (écart avec TEAM_LEADER côté API : `03-security/rbac.md`).

## Tests existants (`npm run test:vehicules`)

`trucks-api.test.ts` (API, ~1100 lignes), `v1a-schema-migration.test.ts`, `v1b-db-schema-migration.test.ts`, `v1b-db-errors-script.test.ts`, `v1c-schema-migration.test.ts`, `vehicules-view.test.ts`, `vehicules-render.test.tsx`. **Aucun test PostgreSQL réel** (`*.pg.test.ts`) pour Vehicles : les triggers/CHECK sont testés par lecture du SQL, pas par exécution. À AUDITER / à ajouter pour V2.

## Points ouverts

- TEAM_LEADER non restreint à son équipe (DÉCISION REQUISE).
- Script legacy `scripts/init-truck-history.ts` : crée des périodes `TruckAssignment` pour l'état courant des camions (en-tête : « à lancer UNE FOIS après `prisma db push` »). **Script à risque**, non adapté aux bases partagées : voir `03-security/production-safety.md`.
- Aucune documentation Vehicles dans `docs/` avant ce kit.
- `Team.company` est en `onDelete: Cascade` alors que `Truck.company` est en `Restrict` : supprimer une entreprise qui possède des véhicules échouera sur la FK Truck. Comportement voulu par V1A (« jamais silencieux »), mais **à confirmer** comme politique de suppression d'entreprise.
