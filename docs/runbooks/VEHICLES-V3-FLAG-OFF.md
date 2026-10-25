# Runbook — désactiver Véhicules V3 (`PLANIFICATOR_VEHICLES_V3_ENABLED`)

Le drapeau masque les routes, pages et tâches V3, mais **les déclencheurs PostgreSQL V3 restent actifs** sur des tables partagées (`mileage_trips`, `trucks`, `assignments`, `employee_assignments`). Couper le drapeau avec des tournées ouvertes bloquerait :

- la clôture d'un trajet V2 lié à une tournée `IN_PROGRESS` (`TRIP_MANAGED_BY_TOUR`) ;
- l'archivage d'un camion qui a une tournée `PLANNED` ou `IN_PROGRESS` ;
- les affectations Chantiers (équipe/chauffeur) en conflit avec une tournée ouverte (`DAILY_*_PLANNING_CONFLICT`).

## Avant de couper le drapeau

1. Lister les tournées ouvertes (lecture seule) :
   ```sql
   SELECT "companyId", "truckId", id, status, "startsAt", "endsAt"
   FROM vehicle_tours WHERE status IN ('PLANNED','IN_PROGRESS') ORDER BY "startsAt";
   ```
2. S'il y en a : les **terminer ou annuler depuis l'interface V3** (drapeau encore ON), par un administrateur de la société. Ne pas modifier ces lignes en SQL direct : la clôture passe par le service (variable `planificator.tour_completion`), qui garde trajet, kilométrage et audit cohérents.
3. Relancer la requête du point 1 : elle doit renvoyer 0 ligne.
4. Couper le drapeau dans Vercel (production), puis redéployer.

## Comportements actifs même drapeau OFF (documentés, voulus)

- Corrections d'entretien (`/api/trucks/[id]/maintenance/entries/[entryId]/corrections`, administrateurs, ajout de lignes seulement) et filtre `corrections: { none: {} }` de la liste `/vehicules`.
- Déclencheurs ci-dessus et verrous consultatifs par société sur les écritures de planning.

## Réserve connue

Deux index uniques identiques sur `mileage_trips(id, truckId, companyId)` (`mileage_trips_id_truck_company_key` et `mileage_trips_id_truckId_companyId_key`), tous deux déclarés dans `schema.prisma`. Sans effet fonctionnel ; leur suppression n'est pas faite car des clés étrangères composites peuvent dépendre de l'un ou de l'autre (à vérifier avant toute migration de nettoyage).
