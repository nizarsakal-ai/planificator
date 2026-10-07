# Politique de migration

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** — dérivée des en-têtes des trois migrations Vehicles (`20261006120000_vehicles_v1a_foundation`, `20261006180000_vehicles_v1b_db_integrity`, `20261006220000_vehicles_v1c_modele`). Norme : ES-001 §12, §23–§24.

## Règle absolue

**Les migrations de toute base partagée (staging, production) passent exclusivement par `prisma migrate deploy`.**
- **Interdits sans exception** sur une base non jetable : `db push`, `migrate reset`, `migrate dev`, réparation SQL improvisée.
- **`migrate resolve`** : seulement après diagnostic écrit et autorisation explicite de l'utilisateur, selon le runbook d'échec de la migration.

Raison constatée : `db push` ne rejoue ni les triggers ni les CHECK ni les backfills ; un environnement créé par `db push` aurait la colonne mais pas les garanties.

## Contenu obligatoire d'une migration (modèle : V1A / V1B-db)

1. **En-tête** :
   - Contenu et **hors périmètre** (ce qui est volontairement absent).
   - **Compatibilité** : ancien code + nouvelle base, et nouveau code + ancienne base.
   - **Ordre de déploiement obligatoire** (migration avant code, ou code avant migration).
   - **Atomicité** : une seule transaction `BEGIN … COMMIT`.
   - **Runbook d'échec** (à ne pas exécuter sans autorisation) : lire le diagnostic, corriger les données **explicitement**, `migrate resolve --rolled-back <nom>`, relancer `migrate deploy`.
   - **Verrous** posés et leur durée.
   - **Rollback manuel** après commit (compensation) et ce qui n'est pas réversible.
2. `SET LOCAL lock_timeout = '5s'` : échec propre et complet plutôt qu'attente indéfinie.
3. **Gardes en lecture seule d'abord** (`DO $$ … RAISE EXCEPTION`), avec échantillon de lignes fautives (LIMIT 20) et message préfixé (`VEHICLES_V1B_DB: …`). Aucune correction automatique des données.
4. DDL ensuite ; backfill minimal (une seule colonne) ; **assertions finales** (contraintes présentes et validées, aucun résidu).
5. Noms de contraintes explicites et versionnés (`truck_assignments_v1b_chronology_check`).
6. DDL identique à `prisma migrate diff` pour ce que Prisma sait exprimer.

## Ordre de déploiement (le build Vercel n'exécute PAS `migrate deploy`)

**L'ordre propre à chaque migration est celui de son en-tête** (V1A et V1C : migration d'abord ; V1B-db : code d'abord). Le tableau ci-dessous donne les cas types.

| Cas | Ordre |
|-----|-------|
| Migration additive que le nouveau code **lit** (ex. V1C `modele`) | `migrate deploy` **avant** le code (sinon Prisma sélectionne une colonne absente → erreur) |
| Migration qui durcit des garanties pendant que l'ancien code reste valide (ex. V1B-db) | code compatible d'abord, preflight, puis `migrate deploy` |
| Suppression / renommage | **interdit** en une étape : expand → migrate → contract sur plusieurs livraisons |

## Procédure

1. Spec + plan de migration (`migration-plan.md` de la spec).
2. Écriture de la migration + **test de contenu SQL** sans base (modèle : `tests/vehicules/v1a-schema-migration.test.ts`, `v1b-db-schema-migration.test.ts`, `v1c-schema-migration.test.ts`).
3. Test PostgreSQL réel pour les invariants (`*.pg.test.ts`) si le métier l'exige.
4. Preflight en lecture seule sur staging (comptages des lignes qui feraient échouer les gardes).
5. Staging : `migrate deploy`, vérification, **preuves**.
6. **Autorisation explicite de l'utilisateur**, puis production : `migrate deploy` dans l'ordre documenté.
7. Vérification post-migration (contraintes valides, triggers présents) et smoke test applicatif.

## Interdits pour un agent

Exécuter une migration en staging ou production ; lancer `migrate resolve` ; corriger des données de production ; modifier une migration déjà appliquée (créer une nouvelle migration).

## Scripts à risque

`db:push`, `db:reset`, `db:migrate` (package.json) et `scripts/init-truck-history.ts` : voir le tableau de `03-security/production-safety.md`.
