# Règles d'intégrité

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** pour Vehicles (migrations et schéma) ; **À AUDITER** pour les autres domaines. Norme : ES-001 §12, §15.

## Principe

Une règle qui doit **toujours** être vraie, quel que soit le code appelant, est une règle de base de données (CHECK, trigger, FK, unique). Le code applicatif la **respecte** et la **traduit en erreur claire** ; il n'en est pas la seule garantie.

## Invariants Vehicles (modèle à imiter)

| Invariant | Garantie en base | Garde applicatif |
|-----------|------------------|------------------|
| Au plus une période ouverte par véhicule | `openForTruckId @unique`, colonne maintenue par trigger `truck_assignments_v1a_open_for_truck_id` (INSERT/UPDATE) | `PERIOD_CONFLICT` (P2002 sur `openForTruckId`) ; clôture avant ouverture |
| Un véhicule archivé n'a ni équipe ni chauffeur | CHECK `trucks_v1a_archived_unassigned_check` | archivage atomique (désaffectation + clôture + archivage) |
| Période jamais close avant son début | CHECK `truck_assignments_v1b_chronology_check` | `endedAt` ≥ `startedAt` ; P2004 classifié en `PERIOD_CONFLICT` |
| Motif de période obligatoire | CHECK `truck_assignments_v1b_reason_required_check` (après BACKFILL) | `reason` toujours renseigné |
| Aucun historique effacé silencieusement | FK `ON DELETE RESTRICT` (truck, chauffeur, team, company) | suppression d'employé refusée proprement avant la FK |
| Un véhicule par équipe | `teamId @unique` | `TEAM_CONFLICT` |
| Matricule unique par entreprise | `@@unique([matricule, companyId])` | `MATRICULE_CONFLICT` |
| Pas de nouvelle affectation vers un objet archivé/inactif | (garde applicatif seul) | `TRUCK_ARCHIVED`, `TEAM_INACTIVE`, `DRIVER_INACTIVE` ; les relations legacy ne sont jamais réécrites |

## Règles transverses

1. **Aucune suppression automatique de données** pour résoudre un conflit (principe repris par `BOOKING-INVARIANTS.md` n°11 et par les gardes de migration).
2. Quand une donnée ancienne est **indémontrable**, on marque (`BACKFILL`), on n'infère pas (`CREATED`/`REASSIGNED` auraient été des inventions).
3. Les gardes de migration **vérifient** les états « impossibles » au lieu de les présumer.
4. Un trigger ou un CHECK est **testé** : par lecture du SQL de la migration (tests `v1*-schema-migration.test.ts`) et, pour le comportement, par un test PostgreSQL.
5. Idempotence : les opérations de reprise (cron, retry) ne créent pas de doublon (modèle : Booking invariants 5, 6, 8, 9).

## À AUDITER

- Invariants des domaines Worksite/Assignment/Absence/Invoice (numérotation `DocumentCounter`, statuts) : aucune vérification effectuée.
