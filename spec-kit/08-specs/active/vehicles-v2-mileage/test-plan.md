# Plan de test — Vehicles V2

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : plan (aucun test écrit). Outillage : `node --import tsx --test` ; ajouter les fichiers à un script `test:vehicules` (liste codée en dur — ne pas l'oublier).

| Exigence | Test prévu | Niveau |
|----------|-----------|--------|
| V2-MIL-001 | courant nullable ; lecture dans la réponse véhicule ; aucun backfill (contenu SQL) | unitaire + migration |
| V2-MIL-002 / 003 | création de trajet avec/sans départ, avec/sans arrivée | unitaire (handler) |
| V2-MIL-004 | fonction pure de distance : cas complet, départ seul, arrivée seule, égalité (0) | unitaire |
| V2-MIL-005 | refus API (`INVALID_PAYLOAD`) **et** CHECK SQL présent (lecture de la migration) **et** violation réelle refusée | unitaire + migration + **pg** |
| V2-MIL-006 | entreprise B : lecture/création/modification refusées ; références d'une autre entreprise = 404 | unitaire |
| V2-MIL-007 | chantier facultatif accepté ; chantier d'une autre entreprise refusé ; aucun effet sur la distance | unitaire |
| V2-MIL-008 | recherche statique : aucun import de géocodage/latitude dans le module ; test qu'une distance ne dépend jamais d'un chantier | unitaire |
| V2-MIL-P02/P04 | deux POST concurrents : un seul passe ou 409 ; courant jamais en régression | **pg** (concurrence réelle) |
| V2-MIL-P01 | plafond et entier ≥ 0 : valeurs limites, décimale, négatif, chaîne | unitaire |
| V2-MIL-P03 | ouverture d'un trajet sur véhicule archivé → `TRUCK_ARCHIVED` ; clôture d'un trajet ouvert avant archivage → acceptée | unitaire |
| V2-MIL-P05 | chevauchement de trajets du même véhicule (si accepté) | unitaire + pg |
| Impact E1 | suppression d'un chantier : le trajet **survit** avec `worksiteId = NULL` | **pg** |
| Impact E2 | suppression d'un employé ayant des trajets : refusée proprement (pas de 500) | unitaire (`employe-delete`) + **pg** |
| Lot V2-0 | `npm run test:vehicules` inchangé et vert après extraction | existant |
| Non-régression V0–V1C | `npm run test:vehicules` complet reste vert | existant |
| Migration | contenu SQL (BEGIN/COMMIT, lock_timeout, gardes, noms de CHECK) | migration |

## Environnement

Tests PostgreSQL uniquement sur base jetable. **Le test pg V2 doit appeler explicitement la garde** (`require-pg-env` / `assertSafeDisposableTestDatabaseUrl`) : elle n'est **pas** universelle dans le dépôt (voir `06-quality/testing-strategy.md`). La base jetable est construite par **`prisma migrate deploy`** (jamais `db push`, qui ne crée ni triggers ni CHECK ; ne pas suivre la reco de `docs/assistant-consultations-fondation.md` l. 100). Prévoir un script dédié (ex. `test:vehicules:pg`) qui enchaîne la garde puis les tests, et **ne jamais** lancer `migrate deploy` sur une URL non gardée. Jamais sur une base partagée.

## Preuves attendues

Sortie complète des suites ; sortie de la requête SQL de vérification post-migration (CHECK/triggers présents) ; captures du parcours UI en staging.
