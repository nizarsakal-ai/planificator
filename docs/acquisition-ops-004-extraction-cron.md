# PLAN-ACQ-OPS-004 — Worker cron Extraction (technique)

| Champ | Valeur |
|-------|--------|
| **Version** | 1.1.0 (R1) |
| **SPEC** | `docs/acquisition-ops-004-extraction-cron.spec.md` v1.1.0 R1 |
| **Route** | `GET /api/cron/acquisition-extraction` |
| **Auth** | `Authorization: Bearer $CRON_SECRET` → 401 avant toute I/O |
| **Scheduler** | Externe uniquement — **absent** de `vercel.json` ; **non configuré** dans ce lot |
| **Autorité métier** | Claim / attempts / persist = **005B** (`runDraftExtractionCore`) uniquement |
| **Production** | Aucune activation ; flags OFF par défaut |

## Architecture

```text
Route (maxDuration=300)
  → Handler (Bearer CRON_SECRET)
  → Gates flags (ordre ci-dessous)
  → Orchestrateur (sélection FIFO SQL, budgets)
  → runDraftExtractionSystem (force=false, sans Role)
  → runDraftExtractionCore (005B)
```

## Ordre des flags (gates)

1. `CRON_SECRET` (HTTP)
2. `ACQUISITION_EXTRACTION_CRON_ENABLED` → `CRON_DISABLED`
3. `PLANIFICATOR_ACQUISITION_ENABLED` → `MASTER_DISABLED`
4. `ACQUISITION_CONTENT_FETCH_ENABLED` → `CONTENT_FETCH_DISABLED`
5. `ACQUISITION_EXTRACTION_ENABLED` → capacité extraction
6. orchestrateur

Inactifs par défaut (`=== "true"` uniquement).

## File d’extraction (sélection SQL — OPS-004-R1)

Éligibles **dans PostgreSQL** (pas d’overfetch + filtre mémoire) :

| Statut | Condition |
|--------|-----------|
| `PENDING_EXTRACTION` | Immédiatement (content non vide, attempts `< maxAttempts`) |
| `FAILED` | `lastExtractionErrorAt IS NOT NULL` **et** `lastExtractionErrorAt + backoff(attemptCount) <= now` **et** attempts `< maxAttempts` |
| `EXTRACTING` | `extractionStartedAt < now - reclaimTtl` (stale 005B) **et** attempts `< maxAttempts` |

### Exclusions

- `PENDING_REVIEW`, `APPROVED`, `REJECTED`, `CONVERTED`
- `FAILED` sans `lastExtractionErrorAt`
- `FAILED` non dus (backoff non écoulé)
- `extractionAttemptCount >= maxAttempts`
- `EXTRACTING` non stale
- content absent ou `normalizedText` vide
- `force=true` (interdit côté cron)

### Backoff SPEC-R1 (identique code / SQL)

```text
backoffMinutes(attemptCount) =
  si attemptCount <= 0 → 0
  sinon min(15, 2^(attemptCount - 1))
```

| attemptCount | Délai |
|--------------|-------|
| ≤ 0 | 0 min |
| 1 | 1 min |
| 2 | 2 min |
| 3 | 4 min |
| 4 | 8 min |
| ≥ 5 | 15 min |

`maxAttempts` = même source 005B (`ACQUISITION_EXTRACTION_MAX_ATTEMPTS`).

### Ordre / tenants

- FIFO : `createdAt ASC`, `id ASC`
- `maxPerCompany` / `maxPerRun` / `maxCompaniesPerRun` appliqués aux candidats **réellement** éligibles
- Listing companies = `DISTINCT companyId` ayant ≥1 candidat éligible SQL, ordre `companyId ASC`
- Un draft au plus une fois par run

## Claim 005B

Unique autorité pour claim `EXTRACTING`, incrément attempts, reclaim, provider, persist, transitions.
L’orchestrateur OPS-004 ne mute jamais les drafts directement.

## Budgets

| Variable | Défaut |
|----------|--------|
| `ACQUISITION_EXTRACTION_MAX_COMPANIES_PER_RUN` | 20 |
| `ACQUISITION_EXTRACTION_MAX_PER_COMPANY` | 10 |
| `ACQUISITION_EXTRACTION_MAX_PER_RUN` | 50 |
| `ACQUISITION_EXTRACTION_CRON_MAX_DURATION_MS` | 240000 |
| `ACQUISITION_EXTRACTION_CRON_SAFETY_MARGIN_MS` | 5000 |
| Timeout provider | `ACQUISITION_EXTRACTION_TIMEOUT_MS` (005B) |
| Route `maxDuration` | 300 s |

Avant chaque extraction : `remaining >= providerTimeout + safetyMargin`.

## Outcomes / compteurs

Run : `SKIPPED` \| `SUCCESS` \| `PARTIAL` \| `FAILED`.
Compteurs : selected, extracted, alreadyExtracted, retryAllowed, failed, inProgress, stateChanged, staleContent, contentMissing, maxAttemptsReached, skipped, unexpectedFailures.

## Concurrence

- Cron/cron et UI/cron : claim + `version` 005B → au plus une persistance `PENDING_REVIEW`
- Throws inattendus du moteur : log `EXTRACTION_UNEXPECTED_FAILURE`, message skippé, run continue (`PARTIAL`)
- Intégrité indépendante du scheduler (chevauchement toléré)

## Rollback

`ACQUISITION_EXTRACTION_CRON_ENABLED ≠ true` → route `SKIPPED` / no-op automatisation.
Extraction manuelle UI reste possible si capacité extraction ON.
Aucun drop de migration (lot sans migration).

## AuthZ UI

Wrapper UI : flags capacité → AuthZ `ADMIN`\|`SUPER_ADMIN` → core.
Wrapper système : pas de Role ; `companyId`/`draftId` serveur uniquement.

## Fichiers

- `src/app/api/cron/acquisition-extraction/route.ts`
- `src/lib/acquisition/extraction/extraction-cron-*.ts`
- `extraction-cron.selection.repository.ts` (SQL éligibilité)
- Wrappers : `runDraftExtraction` / `runDraftExtractionSystem` dans `extraction.service.ts`

## Tests

- `tests/acquisition/extraction-cron.orchestrator.test.ts`
- `tests/acquisition/extraction-cron.route.test.ts`
- `tests/acquisition/extraction-cron.selection.test.ts` (PG anti-starvation)
- `tests/acquisition/extraction-cron.integration.test.ts` (PG + stress)

```bash
export TEST_ACQUISITION_DATABASE_URL="postgresql://…/acquisition_test"
node --import tsx --test tests/acquisition/extraction-cron.selection.test.ts
node --import tsx --test tests/acquisition/extraction-cron.integration.test.ts
```

Ne jamais pointer vers la production. Aucun ajout `vercel.json`.
