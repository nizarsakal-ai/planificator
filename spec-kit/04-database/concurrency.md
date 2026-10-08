# Concurrence

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (`src/lib/vehicules/trucks-api.ts`, invariants Booking, bail d'orchestrateur). Norme : ES-001 §15.

## Techniques en usage

| Technique | Où | Pourquoi |
|-----------|----|----------|
| **Verrou de ligne `SELECT … FOR UPDATE`, ordre fixe (tri par id)** | `lockTrucks` (Vehicles) | Deux modifications croisées ne s'interbloquent pas |
| **`FOR SHARE` sur équipe / employé du tenant** | `readActiveTeam`, `readActiveEmployee` | Un archivage concurrent attend la fin de la transaction : pas de fenêtre entre contrôle et écriture |
| **Transaction atomique** | `$transaction` + `TrucksApiError` (annule tout, puis traduit en HTTP) | Archivage = désaffectation + clôture + archivage, tout ou rien |
| **Sentinelle unique pilotée par trigger** | `openForTruckId` | La base refuse une 2ᵉ période ouverte même si deux requêtes passent le garde applicatif |
| **Classification des conflits** | `classifyUniqueConflict`, `classifyVanishedReference`, `classifyCheckViolation` | P2002 → `MATRICULE_CONFLICT` / `TEAM_CONFLICT` / `PERIOD_CONFLICT`, P2003/P2025 → `*_NOT_FOUND` |
| **Réponse « réessayez »** | `CONCURRENT_UPDATE`, `PERIOD_CONFLICT`, `TEAM_CONFLICT` (409) | Le client peut relancer, sans état incohérent |
| **Bail + fencing de workers** | `AcquisitionOrchestratorLease`, `docs/acquisition-ops-v2-fencing-workers.md` | Un seul worker actif par entreprise/ressource ; revalidation avant mutation |
| **Idempotence par clé** | `AcquisitionDecisionJournal` (migration `acq_decision_journal_idempotency_key`), `ProcessedGmailMessage` | Un retry ne double pas l'effet |
| **`lock_timeout = 5s` en migration** | en-têtes des migrations | Échec propre plutôt qu'attente |

## Règles

1. Toute mutation qui lit puis écrit une même ressource partagée prend un **verrou dans un ordre déterministe** ou s'appuie sur une contrainte d'unicité.
2. Un contrôle d'existence/état suivi d'une écriture **dans la même transaction**, sous verrou, pas en deux appels séparés.
3. Les conflits attendus sont des **409 typés**, pas des 500.
4. Les tâches répétées (cron, retry) sont **idempotentes** et **fencées** (bail + revalidation avant mutation).
5. Tester la concurrence : cas de deux requêtes croisées, et test PostgreSQL pour les contraintes (modèle : `tests/booking/*.pg.test.ts`, `tests/acquisition/multi-gmail-identity-lock.pg.test.ts`).

## Pour Vehicles V2 (kilométrage)

Une saisie de kilométrage concurrente (deux trajets sur un même véhicule) doit suivre ce patron : verrou du véhicule (`lockTrucks`), contrôle de monotonie sous verrou, 409 typé en cas de conflit. Voir `08-specs/active/vehicles-v2-mileage/`.
