# Sûreté de la production

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **règles normatives du kit** ; les éléments marqués VÉRIFIÉ citent le dépôt. ES-001 §23–§25 prévalent.

## Interdits SANS EXCEPTION sur toute base non jetable (locale de test, dédiée et vidable)

Aucune autorisation ne les lève sur une base **partagée** (staging, production) :

- `prisma db push` — ne rejoue ni triggers, ni CHECK, ni backfills (les en-têtes des migrations Vehicles : « N'utiliser que `prisma migrate deploy` »).
- `prisma migrate reset` (et le script `db:reset` = `migrate reset --force`).
- `prisma migrate dev` (script `db:migrate`) : il peut proposer un reset.
- Toute réparation SQL « à la main » sur une base partagée.

## Interdits sans diagnostic écrit **et** autorisation explicite de l'utilisateur

- `prisma migrate resolve` (y compris `--rolled-back`), selon le runbook d'échec de la migration.
- Toute écriture en production par un agent (données, flags, migrations, déploiement).

## Scripts à risque dans le dépôt (VÉRIFIÉ)

| Script | Risque | Règle |
|--------|--------|-------|
| `db:push` | `prisma db push` | développement jetable uniquement |
| `db:reset` | `migrate reset --force` | développement jetable uniquement |
| `db:migrate` | `prisma migrate dev` | développement jetable uniquement |
| `scripts/init-truck-history.ts` | **écrit en base** (crée des périodes `TruckAssignment`) ; son en-tête recommande de le lancer « après `prisma db push` » avec `DATABASE_URL` en argument | script **legacy** : ne pas l'exécuter sur une base partagée ; l'historique est désormais couvert par V1A/V1B (`BACKFILL`) |

**DÉCISION RECOMMANDÉE** (à entériner par ADR) : faire échouer ces scripts si `DATABASE_URL` ne désigne pas une base locale/jetable (réutiliser le garde `safe-test-database-url`).

## Autorisation

Production = **autorisation explicite de l'utilisateur, par action**. Une autorisation donnée pour un contexte (ex. staging) ne s'étend jamais à la production. Les agents ne mergent pas.

## Ordre code / migration

Chaque migration documente l'ordre obligatoire dans son en-tête (VÉRIFIÉ) :
- V1A : `migrate deploy` **avant** le code généré avec le nouveau schéma (Prisma nomme les colonnes).
- V1B-db : code V1B-db d'abord, puis preflight, puis `migrate deploy` (Vercel ne l'exécute pas).
- V1C : `migrate deploy` **avant** le code V1C ; code V1C sur une base sans la colonne = incompatible.

## Feature flags

Les capacités à effet externe sont inactives par défaut (`PLANIFICATOR_ACQUISITION_ENABLED`, `ACQUISITION_*_ENABLED`, `BOOKING_GMAIL_SCAN_ENABLED`). Activation = runbook (`docs/RB-PLAN-ACQ-001-activation-flags.md`), staging d'abord, preuves, autorisation.

## Crons

- Authentification fail-closed (`assertCronBearerAuth`).
- Le cron `acquisition-orchestrator` tourne toutes les heures en production (`vercel.json`, commit `e619b7e`). **Doc existante divergente** : `docs/acquisition-ops-v2-staging-activation.md` dit « hors `vercel.json`, intervalle 5–15 min » (l. 88) et le commentaire de `src/app/api/cron/acquisition-orchestrator/route.ts` (l. 5) dit « non déclaré dans vercel.json (scheduler externe) » — à mettre à jour ; les workers utilisent un bail (`AcquisitionOrchestratorLease`) et des mécanismes de fencing (`docs/acquisition-ops-v2-fencing-workers.md`).
- Un cron temporaire de test ne se commit pas en production (historique : commit « temporary staging orchestrator trigger » revert).

## Après chaque mise en production

Smoke test + preuves attachées (voir `07-deployment/production.md`). Pas de RELEASED sans preuves de déploiement ni de CLOSED sans PRR.
