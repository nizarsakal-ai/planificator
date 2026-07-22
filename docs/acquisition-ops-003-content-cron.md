# PLAN-ACQ-OPS-003 — Worker cron fetch Content Acquisition

| Champ | Valeur |
|-------|--------|
| **Version** | 1.2.1 |
| **SPEC** | PLAN-ACQ-OPS-003-SPEC-R1 |
| **Route** | `GET /api/cron/acquisition-content-fetch` |
| **Hors périmètre** | Extraction OPS-004 ; orchestration OPS-005 ; `vercel.json` ; config Raspberry Pi ; Review / Conversion / Booking |

## Objectif

Drainer automatiquement les drafts Acquisition éligibles **sans** `AcquisitionMessageContent` : fetch Gmail → sanitize → upsert idempotent.

Critères de file (exact) :

- `WorksiteImportDraft.status = PENDING_EXTRACTION`
- `AcquisitionMessage.status = DRAFT_CREATED`
- content absent
- FetchState absent ou (`terminalAt IS NULL` et retry dû)

Indépendant du worker Extraction. Multi-tenant. Idempotent. Kill-switch OPS-001.

## Flags (ordre des gates)

1. `CRON_SECRET` (HTTP 401)
2. `ACQUISITION_CONTENT_CRON_ENABLED` → `CRON_DISABLED`
3. `PLANIFICATOR_ACQUISITION_ENABLED` → `MASTER_DISABLED`
4. `ACQUISITION_CONTENT_FETCH_ENABLED` → `CONTENT_FETCH_DISABLED`
5. orchestrateur

Inactifs par défaut (`=== "true"` uniquement).

## Activation

1. **Appliquer les migrations OPS-003** sur l’environnement cible **avant** d’activer les flags, via `prisma migrate deploy` (ordre automatique) :
   1. `20260721220000_add_acquisition_content_fetch_state` — crée la table `acquisition_content_fetch_states` et ses contraintes / index.
   2. `20260722001000_align_acquisition_content_fetch_state_names` — aligne les noms réellement créés par PostgreSQL (troncature à 63 caractères) sur les noms attendus par Prisma.
2. Déployer le code route/worker.
3. Activer flags (cron + master + content) selon OPS-001.
4. Configurer le scheduler externe (hors ce lot).

**Ne pas** exécuter manuellement uniquement la seconde migration. Prisma enregistre chaque migration dans `_prisma_migrations` et garantit une exécution unique ; les deux s’appliquent dans l’ordre lors d’un `migrate deploy` complet.

**Aucune activation du worker** (flags / scheduler) avant l’application complète des deux migrations.

### Identifiant FetchState

La colonne `id` est un TEXT opaque. Le défaut Prisma `@default(cuid())` n’est **pas** utilisé par le repository OPS-003 : l’INSERT SQL runtime fournit `crypto.randomUUID()`. Aucune logique métier ne dépend du format (cuid vs UUID).

## Scheduler externe

La route **n’est pas** déclarée dans `vercel.json` (Hobby / OPS-002).

Fréquences cibles (UTC) — **non configurées dans ce lot** :

| Action | Schedule cible |
|--------|----------------|
| Content fetch | à définir côté ordonnanceur (ex. décalé après sync/download) |

Présence de la route ≠ activation. Aucun cron content n’est actif tant que le scheduler externe n’appelle pas l’endpoint **et** que les flags ne sont pas ON.

La non-réentrance du scheduler est une **optimisation de coût Gmail**, **jamais** une garantie d’intégrité : le worker reste correct sous chevauchement accidentel.

## Budgets (env optionnels)

| Variable | Défaut |
|----------|--------|
| `ACQUISITION_CONTENT_MAX_COMPANIES_PER_RUN` | 20 |
| `ACQUISITION_CONTENT_MAX_PER_COMPANY` | 20 |
| `ACQUISITION_CONTENT_MAX_PER_RUN` | 100 |
| `ACQUISITION_CONTENT_CRON_MAX_DURATION_MS` | 240000 |
| `ACQUISITION_CONTENT_CRON_MAX_ATTEMPTS` | 5 |
| Route `maxDuration` | 300 s |

## Concurrence (Option A — sans claim)

- Mutations `AcquisitionContentFetchState` : **atomiques** dans une TX courte — `INSERT … ON CONFLICT DO NOTHING` (id aléatoire ; absorbe toute unicité PK / `acquisitionMessageId`, pas de `23505`/`25P02`) puis `UPDATE attemptCount = attemptCount + 1 RETURNING`, puis schedule `nextRetryAt`/`terminalAt` filtré `companyId` + `acquisitionMessageId`.
- Un mark retryable **ne clear jamais** un `terminalAt` déjà posé (poison pill / reset = runbook uniquement).
- Content : contrainte unique + upsert/P2002 → `ALREADY_FETCHED` / `UPDATED`.
- Si un content apparaît pendant qu’un autre run reçoit une erreur : **re-check content** avant mark failure → outcome idempotent, **pas** de `terminalAt` ni d’incrément inutile.
- Throw inattendu de `fetchContent` : log `CONTENT_FETCH_UNEXPECTED_FAILURE`, traité comme retryable (`CONTENT_FETCH_FAILED`), **candidat isolé**, run non aborté.
- Échec de mark FetchState : logué (`CONTENT_FETCH_STATE_MARK_FAILED`), message skippé, **run non aborté**.
- Double fetch Gmail toléré et mesuré (`duplicateFetchSuspected`).
- Aucun lock global ; aucune dépendance au scheduler pour la sûreté.

### Coexistence content + FetchState

Le **content existant** est l’autorité d’éligibilité (message non re-sélectionné).
Un FetchState avec `terminalAt` / `nextRetryAt` / `attemptCount > 0` peut **coexister** comme trace historique. **Aucune suppression silencieuse** de FetchState. Reset opérateur = runbook futur uniquement.

## Poison pills / erreurs

| Catégorie | Comportement |
|-----------|--------------|
| Retryable | `attemptCount++` atomique, `nextRetryAt` (backoff `min(15, 2^n)` min), terminal au `maxAttempts` |
| Permanente | `terminalAt` immédiat |
| CONFIG_TENANT (`GMAIL_NOT_CONNECTED`, `GMAIL_UNAUTHORIZED`, `GMAIL_TOKEN_REFRESH_FAILED`) | skip company ; **ne terminalise pas** les messages ; log `CONTENT_FETCH_TENANT_CONFIGURATION_FAILURE` |
| Throw inattendu `fetchContent` | log `CONTENT_FETCH_UNEXPECTED_FAILURE` ; même chemin retryable (`CONTENT_FETCH_FAILED`) |
| Échec mark FetchState | log `CONTENT_FETCH_STATE_MARK_FAILED` ; candidat skippé ; run continue |

### Colonnes d’audit (nullable, réservées)

`previousTerminalAt`, `previousTerminalErrorCode`, `reactivatedAt`, `reactivatedBy`, `reactivationReason` : présentes pour permettre un reset **non destructif** futur (SPEC-R1). **Non écrites** par OPS-003 runtime.

### Réactivation (hors code OPS-003)

Runbook requis avant **MODULE CLOSED** :

`RB-PLAN-ACQ-003-reactivate-terminal-content-fetch.md`

## Rollback

1. `ACQUISITION_CONTENT_CRON_ENABLED` ≠ `true` (ou master / content OFF)
2. La route devient `SKIPPED` / no-op métier
3. Migration additive : pas de drop obligatoire pour rollback runtime

## Auth

`Authorization: Bearer $CRON_SECRET`

## Tests

- `tests/acquisition/message-content-cron.orchestrator.test.ts`
- `tests/acquisition/message-content-cron.route.test.ts`
- `tests/acquisition/message-content-fetch-state.repository.test.ts`
- `tests/acquisition/message-content-cron.integration.test.ts` (PG si `TEST_ACQUISITION_DATABASE_URL`)
- extension `acquisition-flag-matrix.test.ts`

### Commande PG lorsque l’URL est fournie

```bash
export TEST_ACQUISITION_DATABASE_URL="postgresql://…/acquisition_test"
DATABASE_URL="$TEST_ACQUISITION_DATABASE_URL" npx prisma migrate deploy
DATABASE_URL="$TEST_ACQUISITION_DATABASE_URL" npx prisma migrate status
node --import tsx --test tests/acquisition/message-content-cron.integration.test.ts
# répéter la suite concurrence ≥ 3 fois
```

Ne jamais pointer vers la production.
