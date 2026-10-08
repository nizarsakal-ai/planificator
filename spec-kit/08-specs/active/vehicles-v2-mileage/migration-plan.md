# Plan de migration — Vehicles V2

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **PLAN** (aucune migration écrite). Suit `04-database/migration-policy.md`.

## Contenu (additif uniquement)

1. `ALTER TABLE trucks ADD COLUMN currentMileageKm INTEGER` (nullable, **sans DEFAULT, sans backfill**) + CHECK `trucks_v2_current_mileage_check`.
2. `CREATE TABLE truck_trips (...)` + FK `RESTRICT` (`companyId`, `truckId`, `chauffeurId`) et **`SET NULL` (`worksiteId`)** + index + les 4 CHECK `truck_trips_v2_*`.

Aucune ligne existante modifiée ; aucun DROP ; aucune modification des tables/contraintes V1A–V1C.

## Nom proposé

`prisma/migrations/<AAAAMMJJHHMMSS>_vehicles_v2_mileage/migration.sql`

## Obligations d'en-tête

Contenu / hors-périmètre ; compatibilité ancien code ↔ nouvelle base (additif : ancien code OK) et nouveau code ↔ ancienne base (**incompatible** : Prisma sélectionne `currentMileageKm`) ; **ordre : `migrate deploy` AVANT le code V2** ; transaction unique `BEGIN…COMMIT` ; `SET LOCAL lock_timeout='5s'` ; verrous ; runbook d'échec ; rollback manuel (`DROP TABLE truck_trips`, `DROP COLUMN currentMileageKm` — perd les données saisies).

## Gardes (lecture seule)

Collision de noms (table/contraintes) ; existence des tables parentes ; aucune colonne `currentMileageKm` déjà présente.

## Assertions finales

CHECK présents et validés ; FK conformes (RESTRICT sauf `worksiteId` SET NULL) ; table vide à la création.

## Test

Contenu SQL (modèle `v1c-schema-migration.test.ts`) + test pg pour les CHECK.

## Interdits

`db push`, `migrate reset`, `migrate resolve` sans autorisation ; exécution par un agent en staging/production.
