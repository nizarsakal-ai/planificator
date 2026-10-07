# Modèle de données — Vehicles V2 (PROPOSÉ)

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : proposition à valider (décisions D1, D2, D5, D6). Conventions : `04-database/prisma-conventions.md`.

## `Truck` (ajout)

| Colonne | Type | Remarque |
|---------|------|----------|
| `currentMileageKm` | `Int?` | V2-MIL-001. NULL = inconnu. **Aucun backfill.** CHECK `>= 0` |

## `TruckTrip` (nouvelle table `truck_trips`)

| Colonne | Type | Remarque |
|---------|------|----------|
| `id` | `String @id @default(cuid())` | |
| `companyId` | `String` | FK `Company` **RESTRICT** ; `@@index([companyId])` — V2-MIL-006 |
| `truckId` | `String` | FK `Truck` **RESTRICT** |
| `chauffeurId` | `String?` | FK `Employee` **RESTRICT** (D5) — impact E2 sur `employe-delete.core.ts` |
| `worksiteId` | `String?` | FK `Worksite` **ON DELETE SET NULL** (D5, E1) — V2-MIL-007 (contexte, facultatif) |
| `startedAt` | `DateTime` | |
| `endedAt` | `DateTime?` | |
| `startMileageKm` | `Int?` | V2-MIL-002 |
| `endMileageKm` | `Int?` | V2-MIL-003 |
| `createdAt` / `updatedAt` | `DateTime` | |

Index : `@@index([truckId, startedAt])`, `@@index([companyId])`. Table : `@@map("truck_trips")`.

## Contraintes SQL (CHECK, noms versionnés)

- `truck_trips_v2_start_mileage_check` : `startMileageKm IS NULL OR startMileageKm >= 0`
- `truck_trips_v2_end_mileage_check` : `endMileageKm IS NULL OR endMileageKm >= 0`
- `truck_trips_v2_mileage_order_check` : `endMileageKm IS NULL OR startMileageKm IS NULL OR endMileageKm >= startMileageKm` — **V2-MIL-005**
- `truck_trips_v2_chronology_check` : `endedAt IS NULL OR endedAt >= startedAt`
- `trucks_v2_current_mileage_check` : `currentMileageKm IS NULL OR currentMileageKm >= 0`

## Limite connue (même patron que V1A/V1B)

`companyId` et `truckId` sont des FK **simples** : rien en base n'interdit un trajet combinant la `companyId` d'un tenant et le `truckId` d'un autre (V1A avait volontairement exclu `@@unique([id, companyId])`). **Garantie applicative** : `lockTrucks` filtre `companyId` ; tout trajet est créé sous verrou d'un véhicule appartenant à l'entreprise de session. Une FK composite est une option ultérieure (migration dédiée).

## Dérivé (non stocké)

`distanceKm = endMileageKm − startMileageKm` si les deux existent, sinon `null` — **V2-MIL-004**.

## Hors modèle

Aucune colonne de latitude/longitude de trajet, aucune distance géographique stockée (V2-MIL-008).
