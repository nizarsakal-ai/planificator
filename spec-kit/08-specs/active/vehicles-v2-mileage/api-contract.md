# Contrat d'API — Vehicles V2 (PROPOSÉ)

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : proposition. Convention d'erreur identique à `TrucksErrorCode` : `{ error, code, issues? }`, statut stable, aucun message brut. Les codes de V2 vivent dans un **`TripsErrorCode` séparé** (le contrat V0 n'est pas modifié) ; les codes marqués « existant » y sont redéclarés avec le **même** statut et le **même** message.

## Routes

| Route | Méthode | Rôles | Effet |
|-------|---------|-------|-------|
| `/api/trucks/[id]/trips` | GET | **D4** | Liste des trajets du véhicule (tenant-scoped, pagination bornée) |
| `/api/trucks/[id]/trips` | POST | **D4** | Crée un trajet (départ/arrivée optionnels, chantier/chauffeur facultatifs) |
| `/api/trucks/[id]/trips/[tripId]` | PATCH | **D4** | Complète/clôture un trajet (kilométrage d'arrivée, `endedAt`) |

Lecture du kilométrage courant : champ `currentMileageKm` ajouté à la réponse véhicule existante (champ additif, ne casse pas les clients V1C).

## Validation (Zod strict)

`startMileageKm`, `endMileageKm` : entiers ≥ 0, plafond de plausibilité (D6) ; `worksiteId`, `chauffeurId` : cuid facultatifs ; champs inconnus refusés.

## Erreurs

| Code | Statut | Cas |
|------|--------|-----|
| `UNAUTHENTICATED` / `FORBIDDEN` / `NO_COMPANY` | 401 / 403 / 403 | existants |
| `INVALID_PAYLOAD` | 400 | validation (dont `arrivée < départ`, V2-MIL-005) |
| `TRUCK_NOT_FOUND` | 404 | véhicule absent **ou d'une autre entreprise** |
| `TRUCK_ARCHIVED` | 409 | saisie sur véhicule archivé (existant) |
| `DRIVER_NOT_FOUND` | 404 | chauffeur absent ou d'une autre entreprise (code existant) |
| `WORKSITE_NOT_FOUND` *(nouveau)* | 404 | chantier absent ou d'une autre entreprise |
| `DRIVER_INACTIVE` | 409 | **nouveau trajet refusé** pour un chauffeur inactif (code existant, même règle que V1B) |
| `TRIP_NOT_FOUND` *(nouveau)* | 404 | |
| `TRIP_ALREADY_CLOSED` *(nouveau)* | 409 | |
| `MILEAGE_REGRESSION` *(nouveau, D3)* | 409 | kilométrage courant qui diminuerait |
| `CONCURRENT_UPDATE` | 409 | existant |

**Violation d'un CHECK de trajet** (`truck_trips_v2_*`, erreur Prisma P2004) → `INVALID_PAYLOAD` (400), **pas** `PERIOD_CONFLICT` (réservé à l'historique d'affectation V1B).

## Écriture du kilométrage courant

Avec D2 (a) il n'existe **aucune route d'écriture directe** de `currentMileageKm` : il n'est modifié que par un relevé de trajet (`POST`/`PATCH` ci-dessus), dans la transaction. Le `PATCH /api/trucks/[id]` V0 reste `.strict()` et inchangé.

## Non-objectifs

Aucun endpoint de calcul de distance géographique ; aucun endpoint d'entretien.
