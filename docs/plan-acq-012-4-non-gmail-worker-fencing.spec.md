# PLAN-ACQ-012-4 — Non-Gmail Worker Fencing

| Champ | Valeur |
|-------|--------|
| **Ticket** | PLAN-ACQ-012-4 |
| **Type** | SPEC normative fencing / concurrence Acquisition **non-Gmail** (documentation seule) |
| **Statut** | DRAFT — prêt pour revue R2 |
| **HEAD de référence** | `d0e05b90b23a92416c5648e29b994b30cd8ce222` |
| **Sources normatives** | `docs/plan-acq-012-0-auto-review-guardrails.spec.md` ; `docs/plan-acq-012-1-auto-review-adoption.spec.md` ; `docs/plan-acq-012-2-auto-approve-pilot.spec.md` ; `docs/plan-acq-012-3-auto-convert-controlled.spec.md` |
| **Source technique existante** | `docs/acquisition-ops-v2-fencing-workers.md` |
| **Implémentation** | **Interdite** dans ce lot |
| **Activation runtime** | **Interdite** dans ce lot |

---

## 1. Rôle

PLAN-ACQ-012-4 **définit** le contrat de concurrence / fencing Acquisition requis **avant toute activation automatique large**.

Ce lot :

- **n’implémente pas** le fencing ;
- **ne modifie aucun** worker, lease, flag, test, Prisma, scheduler, Booking, `gmail-scan` ;
- **ne ferme pas** **G-FENCE** (012-0 §11.2 / §16) ;
- **ne prétend pas** que DONE SPEC = fencing livré.

### 1.1 Problème à couvrir

Une **lease** orchestrateur (`acquisition_orchestrator_leases`) peut **expirer** pendant qu’un worker continue son traitement.

Un autre orchestrateur peut alors **acquérir** la même lease (`key` globale `acquisition-orchestrator`).

Il faut empêcher qu’un **worker devenu stale** continue à produire des **effets métier non autorisés**.

Ne pas coder la solution ici. Ticket technique déjà nommé : `PLAN-ACQ-V2-FENCING-WORKERS`.

### 1.2 Portée

| Inclus | Exclu |
|--------|-------|
| Contrat fencing pour workers **réellement orchestrés** hors heartbeat Gmail | Implémentation |
| Inventaire code + gaps | Modification Gmail |
| Chemin **UI extraction** (hors lease) | Activation autoApprove / autoConvert |
| Invariants, `LEASE_STOLEN`, heartbeat / `assertOwned` | Prisma / migrations / scheduler |
| Tests d’acceptation **définis, non codés** | 012-5+ |

---

## 2. Définitions

Noms **réels** du code. Aucune API inventée.

| Terme | Sens code |
|-------|-----------|
| **LEASE** | Rangée `acquisition_orchestrator_leases` identifiée par `key`. Clé unique utilisée : `ACQUISITION_ORCHESTRATOR_LEASE_KEY` = `"acquisition-orchestrator"`. Champs pertinents : `ownerRunId`, `leaseExpiresAt`. Port : `AcquisitionOrchestratorLeaseRepositoryPort`. |
| **LEASE OWNER** | L’exécution dont `ownerRunId` (le `runId` orchestrateur) possède encore la rangée **et** `leaseExpiresAt >= now`. Verdict port : `{ outcome: "OWNED" }`. |
| **LEASE TOKEN / IDENTITÉ** | **`ownerRunId`**. Il n’existe **pas** de type `leaseToken` / token opaque distinct. L’identité d’ownership est le couple `(key, ownerRunId)` passé à `acquire` / `release` / `assertOwned` / `renew`. |
| **HEARTBEAT** | Appel optionnel du port : `renew({ key, ownerRunId, leaseTtlMs })`. Prolonge `leaseExpiresAt` **seulement si** toujours propriétaire et non expiré. Retourne `LeaseOwnershipOutcome`. Présent Prisma + mémoire ; optionnel (`renew?`) sur le port. |
| **ASSERT OWNED** | `assertOwned({ key, ownerRunId })` → `"OWNED"` \| `"NOT_OWNER"` \| `"NOT_FOUND"`. Vérifie owner **et** non-expiration. **Ne prolonge pas** le TTL. |
| **LEASE_STOLEN** | **Pas** un outcome repository. **Signal orchestrateur / runner** : `skipReason: "LEASE_STOLEN"` et/ou `error.code: "LEASE_STOLEN"`. Agrégat run : `hasStolen` → statut global **`PARTIAL`**. Log : `ORCHESTRATOR_LEASE_STOLEN`. Repository sous-jacent : `NOT_OWNER` ou `NOT_FOUND` (ou `renew` qui n’est plus `OWNED`). |
| **STALE WORKER** | Worker (ou itération interne) encore en cours **après** que son `ownerRunId` n’est plus owner. Causes réelles : **expiration** (`leaseExpiresAt < now`, un autre run peut `acquire`) ; **reprise** `acquire` par un autre `ownerRunId`. `release` **ne peut pas** être invoqué avec succès par un owner différent : le SQL exige `key` **et** `ownerRunId` ; un autre owner reçoit `NOT_OWNER` / ne libère pas. Une libération par « autre chemin » n’est possible **que** si ce chemin appelle `release` avec le **même** `ownerRunId` encore valide (ex. `finally` du **même** run). |
| **MID-WORKER FENCING** | Contrôle d’ownership **pendant** une étape (`runners[key]`), pas seulement **entre** deux clés de `STEP_ORDER`. Aujourd’hui : **gmailSync orchestré uniquement**, et **partiel** (`GMAIL_CURRENT_FENCING` = `PAGE_BOUNDARY_PARTIAL`, §5). |
| **GMAIL_CURRENT_FENCING** | Statut **documentaire** (pas un enum code) : `PAGE_BOUNDARY_PARTIAL`. Ownership/`renew` **en tête de page** + fence `assertOwned` **après** le driver. **Pas** un fencing intra-page ni « fully fenced ». |
| **FENCE INTER-ÉTAPES** | `assertOwned` dans `runAcquisitionOrchestrator` **avant** de démarrer chaque clé de `STEP_ORDER`. Si non `OWNED` : étape courante `FAILED` + `LEASE_STOLEN` ; suivantes `NOT_RUN` + `LEASE_STOLEN`. |
| **UNIT CRON** | Routes `/api/cron/acquisition-*` (gmail-sync, attachment-recovery, attachment-download, content-fetch, extraction) **hors** `/api/cron/acquisition-orchestrator`. **Aucune** lease orchestrateur sur ces chemins. |

`LeaseAcquireOutcome` / `LeaseReleaseOutcome` / `LeaseOwnershipOutcome` : voir `acquisition-orchestrator.types.ts`. Ne pas les confondre avec `LEASE_STOLEN`.

---

## 3. État réel actuel

Preuves : `src/lib/acquisition/orchestrator/*`, workers métier cités. **Ne pas affirmer une protection sans preuve.**

Invariant config (réel) : `leaseTtlMs >= maxDurationMs + safetyMarginMs` (`getAcquisitionOrchestratorConfig`). Défauts : `maxDurationMs = 240_000`, `safetyMarginMs = 5_000`, `leaseTtlMs` effectif ≥ `360_000` (ou `minLease` si plus grand). **Cet invariant TTL atténue** le vol pendant un run **si** aucune étape ne dépasse réellement le TTL. Il **n’est pas** du mid-worker fencing.

`STEP_ORDER` = `gmailSync` → `attachmentRecovery` → `attachmentDownload` → `contentFetch` → `extraction`.

Clamp enfant (runners prod) : `max(1_000, min(childDefault, floor(remainingMs * 0.9)))`.

### 3.1 Orchestrateur / lease (socle)

| PATH | LEASE AT START | HEARTBEAT MID-RUN | ASSERT OWNED MID-RUN | SIDE EFFECTS | CURRENT FENCING STATUS |
|------|----------------|-------------------|----------------------|--------------|------------------------|
| `runAcquisitionOrchestrator` (`acquisition-orchestrator.service.ts`) → `GET /api/cron/acquisition-orchestrator` | `acquire({ key: "acquisition-orchestrator", ownerRunId: runId, leaseTtlMs })`. `ALREADY_RUNNING` → run `SKIPPED`. | **Non** (pas de `renew` dans la boucle d’étapes) | **Oui entre étapes**, **non pendant** un runner (sauf si le runner le fait). Après vol : stop des étapes suivantes. `finally` : `release` ; si `NOT_OWNER` et déjà stolen, pas `leaseReleaseFailed`. | Logs `[acquisition-orchestrator]` ; statut run ; **pas** de mutation métier directe | **PROUVÉ inter-étapes** (test `lease stolen mid-run → stop + LEASE_STOLEN` : vol **après** `gmailSync`, **avant** recovery). **NON** mid-worker générique. |

### 3.2 Workers orchestrés

| PATH | LEASE AT START | HEARTBEAT MID-RUN | ASSERT OWNED MID-RUN | SIDE EFFECTS | CURRENT FENCING STATUS |
|------|----------------|-------------------|----------------------|--------------|------------------------|
| **gmailSync** `createProductionStepRunners.gmailSync` → `runGmailSync` → `runAcquisitionGmailSyncDriver` → `syncAcquisitionMailForCompany` | Hérite lease parent (`ownerRunId` = `runId`) | **Page-head seulement** : `shouldContinue` → deadline `Date.now()` + `assertOwned` + `renew` si présent. **Pas** un heartbeat intra-page / après chaque I/O | **Page-head** via `shouldContinue` ; **fence final après le driver** (donc **après** mutations éventuelles de la dernière page). **Pas** d’`assertOwned` avant chaque ingest / `saveSuccessfulPage` | Ingestion messages ; shadow ; cursor `lastHistoryId` (`saveSuccessfulPage` si pagination **complète** succès) ; logs `[acquisition-orchestrator:gmail]` | **`PAGE_BOUNDARY_PARTIAL`** (code). **Pas** fully fenced. §5. Hors livraison 012-4. |
| **attachmentRecovery** `runAcquisitionAttachmentRecoveryOrchestrator` | `assertOwned` **avant** le start de l’étape uniquement | **Non** | **Non** pendant reclaim / retry | Reclaim `PENDING_DOWNLOAD` stale (`reclaimPendingDownload`) ; retry download (mêmes effets que download) ; logs `RECLAIM_*` / recovery | **NON PROTÉGÉ mid-run**. Budget temps interne seulement. |
| **attachmentDownload** `runAcquisitionAttachmentDownloadOrchestrator` → `downloadAcquisitionAttachment` | Idem inter-étape | **Non** | **Non** pendant claim / I/O / persist | `claimForDownload` ; fetch provider ; persist `STORED` / erreurs retry/reject | **NON PROTÉGÉ mid-run**. |
| **contentFetch** `runAcquisitionContentCronOrchestratorDefault` | Idem inter-étape | **Non** | **Non** | Fetch contenu message ; persist content hash/texte ; état retry cron (**Option A sans claim** — commentaire code) | **NON PROTÉGÉ mid-run**. Concurrent fetch possible côté métier. |
| **extraction** `runAcquisitionExtractionCronOrchestrator` → `runDraftExtractionSystem` → `runDraftExtractionCore` → `maybeRunAutoDecisionAfterExtraction` | Idem inter-étape | **Non** | **Non** pendant claim `EXTRACTING`, appel provider, persist, hook AUTO | Claim atomique `EXTRACTING` + version++ ; persist extracted / FAILED ; **hook AUTO** (approve / convert si flags — **non activé** par ce lot) | **NON PROTÉGÉ mid-run**. Claim draft ≠ lease orchestrateur. |
| **UI extraction** — voir §4 | **Aucune lease orchestrateur** | **Non** | **Non** | Identiques au core + AuthZ ADMIN/SUPER_ADMIN | **HORS lease**. **GAP** pour AUTO (§4). |
| **Unit crons** `/api/cron/acquisition-attachment-recovery` \| `…-download` \| `…-content-fetch` \| `…-extraction` \| `…-gmail-sync` | **Aucune** lease `acquisition-orchestrator` | **Non** (sauf Gmail unit : pas le `shouldContinue` orchestrateur) | **Non** | Mêmes workers métier que ci-dessus | **HORS lease**. Ops : *ne pas activer les 5 crons unitaires en parallèle* (`acquisition-ops-v2-staging-activation.md`). **PRECONDITION ops**, pas une preuve fencing. |

Aucun autre runner n’est câblé dans `AcquisitionOrchestratorStepRunners`.

---

## 4. Chemin UI extraction

Chemin réel :

1. `extractWorksiteImportDraft` (`src/lib/actions/acquisition-extraction.actions.ts`) **et/ou** revue → `runDraftExtraction` (`acquisition-review.actions.core.ts`)
2. `runDraftExtraction` (`extraction.service.ts`) — flags + AuthZ `ADMIN` \| `SUPER_ADMIN`
3. `runDraftExtractionCore`
4. si extraction réussie : `maybeRunAutoDecisionAfterExtraction`

**Faits :**

- ce chemin **n’est pas** sous lease orchestrateur ;
- une solution **limitée uniquement à l’orchestrateur** **ne protège pas** ce chemin ;
- AUTO decision / auto-convert **futurs** doivent avoir un **modèle de concurrence cohérent** ici aussi (012-3 §11.1, inchangé).

| Question | Statut 012-4 |
|----------|--------------|
| Lease orchestrateur | **Non applicable** |
| Heartbeat / `renew` | **Absent** |
| `assertOwned` | **Absent** |
| Concurrence réelle aujourd’hui | Claim draft `EXTRACTING` + version (optimistic) ; `EXTRACTION_IN_PROGRESS` si claim frais ; reclaim TTL `EXTRACTING` orphelin (défaut 5 min) |
| Suffisant comme fencing AUTO large | **Non** — claim draft ≠ ownership orchestrateur ; n’empêche pas deux acteurs UI / UI+cron |
| Mécanisme cible UI | **TBD / GAP** — **ne pas inventer** (pas de « fake lease UI », pas d’emprunt Booking) |

**G-FENCE** reste **bloquant** tant que le chemin UI reste joignable pour une activation AUTO **sans** preuve de concurrence dédiée (012-3 : un seul chemin « sous lease » sans traiter l’UI = **NO-GO**).

Oracle test UI actuel : **`MECHANISM_NOT_DEFINED`**. **`BLOCKS_AUTO_LARGE` = YES**. Un test **ne doit pas** supposer `assertOwned` / lease orchestrateur sur ce chemin.

---

## 5. Gmail (référence uniquement)

Gmail **n’est pas modifié** par 012-4.

**`GMAIL_CURRENT_FENCING` = `PAGE_BOUNDARY_PARTIAL`.** Meilleure référence existante, **explicitement partielle**. **Ne pas** présenter Gmail comme fully fenced.

### 5.1 Runner orchestrateur — EXISTING

Sur `runGmailSync` uniquement :

1. En **tête de chaque page**, `shouldContinue` :
   - `Date.now() >= deadlineAtMs` → `false`
   - **ou** `assertOwned !== OWNED` → `false`
   - **ou** `renew` présent et `renew !== OWNED` → `false`
2. Horloges distinctes (fait code) : deadline Gmail = `Date.now()` Node ; lease/`assertOwned`/`renew` = PostgreSQL `clock_timestamp()`.
3. si `shouldContinue === false` : résultat company **PARTIAL**, `partialReason: "BUDGET_EXHAUSTED"`, `error.code: "LEASE_STOLEN"` (même si la cause peut être **deadline**, pas seulement vol — **sémantique actuelle**, ne pas la « corriger » dans ce lot)
4. fence **final** runner **après** le driver : si plus `OWNED` → étape `FAILED` + `skipReason: "LEASE_STOLEN"` (y compris si le driver a renvoyé SUCCESS)

### 5.2 NOT CURRENTLY GUARANTEED (intra-page)

**Après** un `shouldContinue` OK, **sans** nouveau contrôle ownership dans **cette même page**, le code peut encore :

- attendre `listMessagesPage` ;
- ingérer les messages de la page (`registerIncomingMessage`) ;
- produire les projections shadow ;
- appeler `saveSuccessfulPage` / avancer `lastHistoryId` (si pagination **complète** succès, `finalHistoryId !== cursor`).

Le fence final intervient **après** le driver, donc **après** les mutations éventuelles de la **dernière** page.

**Non garantis aujourd’hui :**

- `assertOwned` immédiatement avant **chaque** mutation métier ;
- `assertOwned` après **toute** opération longue intra-page ;
- `assertOwned` **immédiatement avant** `saveSuccessfulPage` / cursor advance.

`GMAIL_CURSOR_FENCE` = **TBD_TARGET** (contrat cible, **pas** EXISTING).

### 5.3 Réutilisable conceptuellement

- `assertOwned` puis `renew` atomique (update SQL conditionné `ownerRunId` + `leaseExpiresAt >= now`)
- arrêt **fail-closed au prochain check de frontière** : ne pas finaliser SUCCESS orchestrateur si plus owner au fence final
- ne pas appeler `release` pour « récupérer » une lease volée (le `finally` parent ignore `NOT_OWNER` si `leaseStolen`)
- cursor Gmail : **non avancé** sur le chemin `shouldContinue === false` (pas d’appel `saveSuccessfulPage` dans ce return)

### 5.4 Spécifique Gmail — ne pas copier aveuglément

- `shouldContinue` est un hook du **sync mail** (boucle pages), pas une API générique des autres orchestrateurs enfant
- mélange **budget** / **lease** dans `partialReason: "BUDGET_EXHAUSTED"`
- granularité **page**, pas mutation / pas I/O
- cursor `lastHistoryId` n’existe pas pour extraction / download / content
- unit cron `GET /api/cron/acquisition-gmail-sync` **n’injecte pas** `shouldContinue`, **n’utilise pas** la lease orchestrateur, **n’a pas** de fence final `assertOwned`
- Booking `gmail-scan` est **un autre pipeline** — interdit d’y toucher (§13)

Tests Gmail `shouldContinue` mid-page : **non** trouvés sous `tests/` (seul vol **inter-étapes** + `renew` repository). Preuve Gmail = **code partiel** ; **pas** une preuve de fencing intra-page.

---

## 6. Workers non-Gmail

Chaque worker **n’exige pas** le même mécanisme. Durées : **bornes config**, pas des SLA mesurés prod (pas de preuve runtime ici).

### 6.1 extraction (orchestrateur)

| Critère | Constat |
|---------|---------|
| Durée potentielle | Cron défaut `maxDurationMs = 240_000` (cap 900_000) ; provider timeout défaut **30_000** (clamp 5–60s) ; jusqu’à 50 drafts / 20 companies (défauts) — une extraction **peut** considérer une fraction importante du budget parent **sans** `renew` |
| Side effects | `EXTRACTING` claim ; persist sujets extraits ; `PENDING_REVIEW` / `FAILED` ; hook `maybeRunAutoDecisionAfterExtraction` |
| Points de mutation | `draftExtractionRepository` claim + persist versionné ; review/convert **si** AUTO flags (aujourd’hui OFF) |
| Risque si lease expirée | Stale run **termine** persist + **peut** AUTO-approve/convert **après** qu’un nouveau run a commencé `extraction` / reclaim `EXTRACTING` |
| Besoin heartbeat | **Oui** si la durée réelle peut approcher / dépasser le TTL restant — **TBD** fréquence |
| Besoin `assertOwned` avant mutation | **REQUIRED** avant claim et avant persist post-provider pour un futur GO AUTO large **sur ce chemin** (§10) |
| Si ownership perdu | Cible §8 : **stop fail-closed** ; ne pas SUCCESS ; ne pas lancer AUTO ; **pas** de rollback magique du claim déjà commité |

### 6.2 attachment download

| Critère | Constat |
|---------|---------|
| Durée potentielle | Défaut 240s ; I/O réseau + storage par PJ ; boucle companies/PJ avec `isTimeBudgetExceeded` **seulement** (pas lease) |
| Side effects | Claim download ; objet storage ; statut `STORED` / retry / reject |
| Points de mutation | `claimForDownload` ; persist download |
| Risque si lease expirée | Double traitement possible avec un second orchestrateur / unit cron ; atténué **partiellement** par claim PJ (optimistic) **≠** lease |
| Besoin heartbeat | **RECOMMENDED** si I/O peut dépasser TTL restant ; **TBD** si preuve `maxDurationMs` strictement sous TTL+marge **et** pas d’activation AUTO large dépendante de ce step |
| Besoin `assertOwned` avant mutation | **RECOMMENDED** avant persist `STORED` ; **REQUIRED** pour traitements longs prod au sens 012-0 §11.2 |
| Si ownership perdu | Stop ; pas SUCCESS ; effets déjà `STORED` **conservés** (idempotence `ALREADY_STORED`) |

### 6.3 attachment recovery

| Critère | Constat |
|---------|---------|
| Durée potentielle | Défaut 240s ; phases RECLAIM puis RETRY |
| Side effects | `reclaimPendingDownload` (retour `DISCOVERED`) ; retries = download |
| Points de mutation | Statuts PJ ; compteurs retry |
| Risque si lease expirée | Reclaim concurrent ; courses sur TTL reclaim PJ (défaut 20 min) **≠** TTL lease (360s) |
| Besoin heartbeat | **RECOMMENDED** (même logique que download) |
| Besoin `assertOwned` avant mutation | **RECOMMENDED** avant chaque reclaim / retry |
| Si ownership perdu | Stop fail-closed ; reclaim déjà fait **non rollbacké** |

### 6.4 content fetch

| Critère | Constat |
|---------|---------|
| Durée potentielle | Défaut 240s ; fetch provider par message ; `BUDGET_MARGIN_MS` interne |
| Side effects | Contenu normalisé + hash ; état d’erreur/retry cron |
| Points de mutation | Tables content / fetch-state — **pas de claim** (Option A) |
| Risque si lease expirée | **Plus élevé** (moins de mutex métier) : double fetch / double persist |
| Besoin heartbeat | **RECOMMENDED** / plutôt **REQUIRED** pour traitements longs (absence de claim) |
| Besoin `assertOwned` avant mutation | **REQUIRED** avant persist content pour GO traitements longs ; **TBD** détail d’implémentation |
| Si ownership perdu | Stop ; persist déjà commité **conservé** ; retries doivent rester compatibles duplication hash / `ALREADY_PRESENT` |

### 6.5 Autres

Pas d’autre worker dans `STEP_ORDER`. AUTO n’est **pas** un worker : c’est un **hook post-extraction** (`maybeRunAutoDecisionAfterExtraction`). Il hérite du fencing du chemin d’extraction **uniquement s’il y en a un**.

---

## 7. Contrat fencing cible

Invariants **normatifs** pour une future implémentation. **Compatibles** avec le code actuel (transactions courtes, claims versionnés, pas de rollback global).

1. Un **stale worker** ne doit **pas** produire de **nouvelle** mutation métier **après** détection de perte d’ownership.
2. La perte d’ownership doit être **détectable** via `assertOwned` / `renew` (`NOT_OWNER` \| `NOT_FOUND`).
3. L’arrêt doit être **fail-closed** : pas de SUCCESS d’étape si plus owner ; pas d’AUTO dans la même continuation.
4. **Aucune** tentative de **récupération silencieuse** d’ownership dans le même worker (`acquire` de rattrapage **interdit** au stale run).
5. **Aucune** mutation Booking ; aucun cursor Booking ; aucun `/api/cron/gmail-scan`.
6. Les **retries ultérieurs** (nouveau `runId`, claim draft/PJ, `ALREADY_*`) doivent rester dans les **garanties d’idempotence existantes** (012-0 / 012-3) — **bornées**, pas « retry always safe ».
7. Heartbeat / assert **ne remplacent pas** les claims `EXTRACTING` / `claimForDownload` / version review/convert.
8. Un contrôle **avant** une transaction **ne garantit pas** l’ownership **pendant** la transaction (§11).
9. Ce contrat s’applique au **chemin orchestrateur**. Le chemin **UI** reste **GAP** jusqu’à modèle dédié (§4) — **ne pas** forcer une lease orchestrateur sur la Server Action.
10. **Portée lease 012-4 (contrat initial, aligné code) :** une seule clé `"acquisition-orchestrator"` **sérialise les runs orchestrateurs globalement**, **pas** par `companyId`. Un modèle per-company est **HORS SCOPE / TBD** (pas inventé ici). Deux companies dans le **même** run partagent cette lease ; un second run orchestrateur (toute company) reçoit `ALREADY_RUNNING` tant que la lease est tenue.

**Interdit** d’écrire dans une implémentation future une règle incompatible avec :

- persist extraction (relecture hash + update `EXTRACTING`+version) ;
- conversion `updateMany` `APPROVED`+version ;
- cursor Gmail « persist seulement après pagination complète succès ».

---

## 8. LEASE_STOLEN

Comportement **attendu** (cible). Distinguer **déjà vrai** (inter-étapes / Gmail final) et **étendu** (mid-worker non-Gmail — **non implémenté**).

| Sujet | Contrat |
|-------|---------|
| Signal / erreur | `skipReason: "LEASE_STOLEN"` et/ou `error: { code: "LEASE_STOLEN", message: … }`. Repository : **pas** d’outcome `LEASE_STOLEN` — mapper depuis `assertOwned`/`renew` ≠ `OWNED`. |
| Niveau log | Existant : `ORCHESTRATOR_LEASE_STOLEN` `{ runId, step }` **info** `console.log` préfixe `[acquisition-orchestrator]`. Cible mid-worker : **même famille de log**, step = worker concerné. **Ne pas** inventer un sink métriques. |
| Statut étape | Étape **en cours** : `FAILED` (ou, Gmail intra-loop actuel : PARTIAL driver + FAILED fence final). Étapes **suivantes** : `NOT_RUN` + `skipReason: "LEASE_STOLEN"`. |
| Statut orchestrateur | **`PARTIAL`** si `hasStolen` (`aggregateOrchestratorStatus`). **Ne pas** promettre `FAILED` global (contredit le code actuel). |
| Cursor Gmail | **EXISTING :** `shouldContinue=false` → pas de `saveSuccessfulPage`. **Non garanti :** cursor advance de la page déjà autorisée (vol survénu intra-page). **`GMAIL_CURSOR_FENCE` = TBD_TARGET** : `assertOwned` **immédiatement avant** `saveSuccessfulPage`. |
| Cursor / sélection autres workers | **Pas** de `lastHistoryId`. Extraction/download/content : **pas d’advance cursor scan**. Selection SQL « dû » / reclaim TTL métier **peuvent** re-sélectionner plus tard — c’est voulu pour retry, **pas** un rollback. |
| Retries | Un **nouveau** run (autre `ownerRunId`) **peut** reprendre le travail. Le stale run **ne retry pas** en boucle interne pour « réacquérir ». |
| Side effects déjà commis | **Conservés.** **Aucun rollback** lease → métier. Reclaim `EXTRACTING` / retry PJ / `ALREADY_EXTRACTED` / `ALREADY_STORED` / `ALREADY_PRESENT` restent les filets existants. |
| Release | `release({ key, ownerRunId })` **conditionné** par le couple. Un **autre** owner : `NOT_OWNER`, **ne libère pas**. Le stale qui n’est plus owner : `NOT_OWNER` **attendu** (ex. après `acquire` par un autre `runId`) ; ne pas traiter ça comme incident si déjà `leaseStolen` (code actuel). |

**Non-promesses :** rollback TX déjà commitée ; interruption d’un appel Anthropic / HTTP déjà parti ; unicité globale anti-doublon.

---

## 9. Heartbeat

### 9.1 Quand c’est nécessaire

Heartbeat (`renew`) est un **prolongement de TTL**, **pas** un fencing intra-opération.

Il est **pertinent** seulement si le code tourne **sous** lease orchestrateur, **et** au moins une des deux est vraie :

- l’étape peut durer assez longtemps pour que `leaseExpiresAt` tombe **avant** la fin **malgré** l’invariant TTL≥maxDuration (hang, dépassement, horloges Node vs PG, clamp enfant) ;
- on vise un GO **auto/convert large** / **traitements longs prod** (012-0 §11.2) — alors **ne pas** s’appuyer **uniquement** sur l’invariant TTL.

Heartbeat **NOT_APPLICABLE** sur le chemin UI (pas de lease) — §4 GAP. **Pas** applicable tel quel aux unit crons (pas de lease orchestrateur).

### 9.2 Fréquence relative au TTL

**Aucune valeur de période n’est figée ici.**

Il n’existe pas de `heartbeatIntervalMs` dans le code. Gmail renouvelle **par page**, pas sur un timer.

Toute fréquence numérique (fraction de TTL, intervalle fixe) = **TBD** jusqu’à preuve (mesure durée page/item **ou** intention d’implémentation dédiée hors ce lot).

Borne qualitative (non chiffrée) : un `renew` doit intervenir **avant** expiration **si** le worker continue ; spam `renew` à chaque micro-mutation **non exigé**.

### 9.3 Opérations longues

| Opération | Heartbeat |
|-----------|-----------|
| Boucle Gmail pages | **EXISTING page-head seulement** (`PAGE_BOUNDARY_PARTIAL`). **Pas** un heartbeat après chaque I/O / ingest intra-page |
| Download I/O + storage | **TBD** — candidat |
| Recovery reclaim/retry boucle | **TBD** — candidat |
| Content fetch HTTP + persist | **TBD** — candidat |
| Appel provider extraction (jusqu’à 60s) | **TBD** — un `renew` **autour** de l’appel ne **coupe pas** l’appel en cours (§11) |
| `maybeRunAutoDecisionAfterExtraction` | Heartbeat **insuffisant** seul ; **assertOwned** avant AUTO (§10) |

### 9.4 Ce qu’un heartbeat doit vérifier

`renew` **déjà** : même owner, lease non expirée, puis étend `leaseExpiresAt` de `leaseTtlMs`.

Cible : si `renew` ≠ `OWNED` → traiter comme **LEASE_STOLEN** (§8), **sans** `acquire` de compensation.

---

## 10. Assert-owned avant mutation

Évaluation **contractuelle**. **Pas** un backlog de diffs. **Ne pas** lire une case comme « le code le fait déjà » hors `EXISTING`.

Légende :

| Statut | Sens |
|--------|------|
| **EXISTING** | Le code le fait **aujourd’hui**, à la granularité indiquée |
| **TARGET_REQUIRED** | Exigé pour un futur GO (AUTO large / traitements longs) **sur ce chemin sous lease** |
| **TARGET_RECOMMENDED** | Souhaité pour ce chemin sous lease ; pas forcément bloquant seul |
| **NOT_APPLICABLE** | Pas d’ownership lease sur ce chemin / pas de curseur / pas d’AUTO |
| **TBD** / **TBD_TARGET** | Cible ou mécanisme **à définir** ; **pas** existant |
| **NOT_CURRENTLY_GUARANTEED** | Le check existant **ne couvre pas** ce point (fenêtre intra-page / intra-item) |

| Chemin | Avant écriture métier critique | Après opération longue | Avant cursor advance | Avant auto-decision | Avant conversion automatique |
|--------|--------------------------------|------------------------|----------------------|---------------------|------------------------------|
| Orchestrateur — **entre** steps | **EXISTING** (`assertOwned` avant de **démarrer** l’étape) | **NOT_APPLICABLE** (hors runner) | **NOT_APPLICABLE** | **NOT_APPLICABLE** | **NOT_APPLICABLE** |
| gmailSync mid-run | **EXISTING** page-head `shouldContinue` seulement. **NOT_CURRENTLY_GUARANTEED** immédiatement avant ingest / shadow. **Pas** fully fenced | **NOT_CURRENTLY_GUARANTEED** intra-page (list / ingest après le check). Fence final = **après** le driver | **TBD_TARGET** (`GMAIL_CURSOR_FENCE` : immédiatement avant `saveSuccessfulPage`). **EXISTING :** skip `saveSuccessfulPage` si `shouldContinue=false` **avant** la page | **NOT_APPLICABLE** | **NOT_APPLICABLE** |
| attachmentRecovery mid-run | **TARGET_RECOMMENDED** ; **TARGET_REQUIRED** si GO traitements longs. **Pas EXISTING** | **TARGET_RECOMMENDED**. **Pas EXISTING** | **NOT_APPLICABLE** | **NOT_APPLICABLE** | **NOT_APPLICABLE** |
| attachmentDownload mid-run | **TARGET_RECOMMENDED** ; **TARGET_REQUIRED** si GO traitements longs. **Pas EXISTING** | **TARGET_RECOMMENDED**. **Pas EXISTING** | **NOT_APPLICABLE** | **NOT_APPLICABLE** | **NOT_APPLICABLE** |
| contentFetch mid-run | **TARGET_REQUIRED** pour GO traitements longs (pas de claim). **Pas EXISTING** | **TARGET_RECOMMENDED**. **Pas EXISTING** | **NOT_APPLICABLE** | **NOT_APPLICABLE** | **NOT_APPLICABLE** |
| extraction orchestrateur mid-run | **TARGET_REQUIRED** pour GO AUTO large / longs. **Pas EXISTING** | **TARGET_REQUIRED** après provider **avant** persist. **Pas EXISTING** | **NOT_APPLICABLE** | **TARGET_REQUIRED**. **Pas EXISTING** | **TARGET_REQUIRED**. **Pas EXISTING** |
| extraction UI | **NOT_APPLICABLE** (pas de lease ; **pas** d’`assertOwned` à tester) | **NOT_APPLICABLE** | **NOT_APPLICABLE** | **TBD** (mécanisme ≠ lease). **MECHANISM_NOT_DEFINED** | **TBD**. **MECHANISM_NOT_DEFINED** |
| Unit crons | **NOT_APPLICABLE** vis-à-vis de **cette** lease (**aucun** faux `assertOwned`). **GAP** si ∥ orchestrateur | **NOT_APPLICABLE** / **TBD** par chemin | **NOT_APPLICABLE** (sauf unité Gmail : pas de `shouldContinue` orchestrateur) | **TBD** si AUTO sur unit cron extraction | **TBD** |

**Cible AUTO sous orchestrateur :** ne **pas** appeler `maybeRunAutoDecisionAfterExtraction` sur un run **stale**. Aujourd’hui : **aucun** `assertOwned` dans `extraction.service.ts` ni `auto-decision.service.ts`.

**UI / unit cron :** un test **ne doit pas** supposer `assertOwned` disponible. **AUTO large** impliquant ces chemins = **NO-GO** tant que protection **non définie et non prouvée**.

---

## 11. Transactions et limites

Garanties **bornées** :

| Affirmation | Conséquence |
|-------------|-------------|
| Un `assertOwned` **avant** TX ne protège pas une expiration **pendant** la TX | Fenêtre résiduelle acceptée ; TX doivent rester **courtes** (déjà le cas persist extraction / convert) |
| Un `renew` **externe** n’interrompt pas une TX ni un HTTP déjà lancé | Heartbeat ≠ cancellation cooperative du provider |
| Fencing ≠ rollback global | Effets commités restent ; voir §8 |
| Idempotence ≠ fencing | `ALREADY_*` / version **limitent les dégâts**, n’empêchent pas un stale d’**essayer** |
| Optimistic concurrency ≠ lease ownership | `EXTRACTING`+version, `claimForDownload`, claim convert : mutex **ressource**. Lease : mutex **run orchestrateur global** (une clé pour **toutes** les companies) |
| Lease globale ≠ isolation tenant | Deux companies dans **le même** run partagent **une** lease. UI de la company A n’est **pas** fencée par la lease du cron |

Ne pas documenter un « stop the world » ou un abort Prisma depuis heartbeat.

---

## 12. AUTO / REVIEW

012-0 … 012-3 **préservés intégralement**.

| ID | Statut après 012-4 SPEC |
|----|-------------------------|
| **G-FENCE** | **OPEN** — mid-worker non-Gmail **incomplet** ; Gmail = `PAGE_BOUNDARY_PARTIAL` seulement ; UI / unit crons **sans** lease ; tests mid-worker **non implémentés** |
| G-INV, G-RB, G-MASTER-SERVICE-SCOPE | Inchangés |
| P-ACTOR, P-CONV, P-STAGE | Inchangés |
| Critères AUTO_APPROVE_ONLY / AUTO_APPROVE_CONVERT / HUMAN_REVIEW_REQUIRED | **Non modifiés** |
| Flags `=== "true"` | Inchangés |

**G-FENCE reste bloquant** pour une activation automatique **large** lorsque le chemin concerné n’est pas suffisamment protégé (012-0 §11.2).

012-4 **n’autorise pas** de réinterpréter un pilote borné 012-2/012-3 comme GO fencing.

---

## 13. Booking isolation

Aucune solution de fencing Acquisition **ne doit** :

- modifier Booking (`src/lib/booking/**`) ;
- utiliser un cursor Booking ;
- modifier `/api/cron/gmail-scan` ;
- partager la lease Booking (il n’y a **pas** de partage aujourd’hui ; **ne pas** en créer) ;
- créer une dépendance Acquisition → Booking.

Constat HEAD : **aucun** import Booking sous `src/lib/acquisition` (012-0 §10). 012-4 n’y touche pas.

---

## 14. Tests d’acceptation requis

Légende d’état d’un test :

| État | Sens | Requis pour |
|------|------|-------------|
| **TEST_DEFINED** | Setup, action, oracle (résultat + effets interdits) **normatifs** dans cette SPEC | **SPEC DONE** |
| **TEST_IMPLEMENTED** | Test présent dans `tests/` | **FENCING_IMPLEMENTATION_READY** (selon scope) |
| **TEST_PASSING** | Test vert sur le HEAD d’implémentation | **FENCING_IMPLEMENTATION_READY** |

Ce lot vise **TEST_DEFINED**. **TEST_IMPLEMENTED** / **TEST_PASSING** = **non** satisfaits ici (sauf ancrages déjà existants **inter-étapes** / `renew` repository, insuffisants pour mid-worker non-Gmail).

Ancrages code existants (non exhaustifs) : `acquisition-orchestrator.service.test.ts`, `acquisition-orchestrator-lease.test.ts`, `acquisition-r2-corrections.test.ts` (`renew`).

**Contrat lease 012-4 :** sérialisation **globale** (`key = "acquisition-orchestrator"`). **Pas** de lease per-company.

### 14.1 Oracles critiques

#### A. Concurrence — même company — TEST_DEFINED

| Champ | Oracle |
|-------|--------|
| Setup | Company C. Run orchestrateur R1 : `acquire` OK, `ownerRunId=R1`. Worker W (extraction / download / recovery / content selon le cas) **en cours** pour C. |
| Action | Lease perdue pour R1 (expire **ou** `acquire` par R2). W stale **détecte** la perte (`assertOwned`/`renew` ≠ `OWNED`, une fois le fencing mid-run **ciblé** en place). W tente une **nouvelle** mutation critique. Un second `runAcquisitionOrchestrator` (même C) pendant que R1 tient encore la lease. |
| Résultat attendu | (1) Second run tant que lease R1 valide : `SKIPPED` / `ALREADY_RUNNING`, steps `NOT_RUN`. **Pas** une lease per-company. (2) Après détection de perte : W **n’autorise aucune nouvelle mutation critique** (fail-closed / `LEASE_STOLEN`). |
| Effets interdits | Re-`acquire` silencieux par W. Succès d’étape après détection. AUTO decision/convert après détection. Inventer une clé par `companyId`. |
| Statut | Orchestrateur : `PARTIAL` si `LEASE_STOLEN` (code actuel). Épreuve mid-worker non-Gmail : **TEST_DEFINED**, **pas TEST_IMPLEMENTED**. |
| **BLOCKS_AUTO_LARGE** | **YES** tant que (2) n’est pas **TEST_PASSING** sur les workers AUTO-activés. |

#### B. Companies différentes — TEST_DEFINED

| Champ | Oracle |
|-------|--------|
| Setup | Companies A et B. Run R1 `acquire` OK (traite A, ou A puis B dans `STEP_ORDER`). |
| Action | Un second run R2 démarre (company B ou A) **pendant** que la lease R1 est encore `OWNED`. |
| Résultat attendu | **Sérialisation globale conservée :** R2 → `ALREADY_RUNNING` / `SKIPPED`, **indépendamment** de la company. A et B dans **le même** run R1 : **une** lease, pas deux owners. |
| Effets interdits | Promettre que A et B peuvent tenir **deux** leases orchestrateur en parallèle. Créer `acquisition-orchestrator:{companyId}`. Rollback métier de A parce que B est skippé. |
| Statut | Comportement `acquire` **EXISTING**. Test concurrence globale : **TEST_DEFINED** ; couverture test actuelle **partielle** (`ALREADY_RUNNING`). Modèle per-company : **HORS SCOPE / TBD**. |
| **BLOCKS_AUTO_LARGE** | **NO** à lui seul (c’est le modèle actuel). **YES** si une implémentation **change** le scope lease sans SPEC. |

#### C. Perte ownership après effets partiels — TEST_DEFINED

| Champ | Oracle |
|-------|--------|
| Setup | Worker sous lease. Au moins **une** mutation critique **déjà commitée** (ex. PJ `STORED`, draft `EXTRACTING`/`PENDING_REVIEW`, message ingéré, reclaim `DISCOVERED`). |
| Action | Perte d’ownership. Détection. Tentative de **nouvelle** mutation (persist suivant, AUTO, cursor, download suivant). |
| Résultat attendu | Effets **déjà commités restent**. **Aucun rollback global**. Après **détection** : **aucune** nouvelle mutation critique par le stale. Fenêtre **avant** détection (ex. intra-page Gmail) : **NOT_CURRENTLY_GUARANTEED** — ne pas la tester comme interdite **aujourd’hui** ; la réduire est **cible** mid-run non-Gmail / `GMAIL_CURSOR_FENCE`. |
| Effets interdits | Delete/revert automatique des lignes déjà persistées. Exactement-une-fois universel. |
| Statut | **TEST_DEFINED**. **TEST_IMPLEMENTED** non-Gmail : non. |
| **BLOCKS_AUTO_LARGE** | **YES** si AUTO peut être cette « nouvelle mutation » après détection, sans preuve. |

#### D. Retry après lease loss — TEST_DEFINED

| Champ | Oracle |
|-------|--------|
| Setup | Après C : état persistant réel (claims, `ALREADY_*`, versions, contenu hash). |
| Action | **Nouveau** run `ownerRunId` valide, **même** company / mêmes items. |
| Résultat attendu | Reprise **selon l’état persistant**, via mécanismes **déjà** présents (claim draft/PJ, `ALREADY_STORED` / `ALREADY_EXTRACTED` / logs `CONTENT_FETCH_ALREADY_PRESENT`, `ALREADY_CONVERTED`). **Aucun** rollback implicite du run perdu. **Aucune** garantie universelle exactly-once. |
| Effets interdits | Dupliquer au-delà des filets **déjà** documentés 012-0/012-3. Rejouer AUTO si les gates l’interdisent encore. |
| Si idempotence worker **non prouvée** | Oracle = **GAP** : préciser le filet **avant** `FENCING_IMPLEMENTATION_READY` pour **ce** worker. Content (Option A sans claim) : **GAP** concurrence fetch ; upsert/P2002 **borné** — pas exactly-once. |
| **BLOCKS_AUTO_LARGE** | **YES** pour un worker AUTO si GAP idempotence **non** traité. |

#### E. UI extraction vs cron / orchestrateur — TEST_DEFINED

| Champ | Oracle |
|-------|--------|
| Setup | Appel `runDraftExtraction` (Server Action ou revue). **Pas** de `runAcquisitionOrchestrator`. |
| Action | (1) Observer lease / `assertOwned`. (2) Extraction OK → `maybeRunAutoDecisionAfterExtraction` **si** flags (aujourd’hui OFF). |
| Résultat attendu | **Aucune** lease orchestrateur. `assertOwned` **absent** — un test qui l’exige en UI **échoue la SPEC** (mauvais oracle). Concurrence actuelle = claim `EXTRACTING`+version seulement. Contrat cible UI = **mécanisme à définir** (**pas** inventé). |
| Oracle actuel | **`MECHANISM_NOT_DEFINED`**. |
| Effets interdits | Supposer que le fencing orchestrateur protège l’UI. Forcer `acquire` dans la Server Action **dans ce lot** (hors scope). |
| **BLOCKS_AUTO_LARGE** | **YES** tant que le chemin UI reste activable pour AUTO **sans** mécanisme défini **et** **TEST_PASSING**. |

#### F. Unit crons — TEST_DEFINED

| Champ | Oracle |
|-------|--------|
| Setup | `GET /api/cron/acquisition-gmail-sync` \| `…-attachment-recovery` \| `…-attachment-download` \| `…-content-fetch` \| `…-extraction` **sans** passer par `/api/cron/acquisition-orchestrator`. |
| Action | Exécuter le handler (gates peuvent SKIPPED). Inspecter lease / `shouldContinue` / `assertOwned`. |
| Résultat attendu | **Aucune** lease `acquisition-orchestrator`. **Aucun** faux `assertOwned`. Gmail unit : **pas** de `shouldContinue` orchestrateur (ne pas généraliser `PAGE_BOUNDARY_PARTIAL`). Protection future : **TBD par chemin**. |
| Effets interdits | Traiter un unit cron SUCCESS comme preuve de fencing. Activer unit crons **en parallèle** de l’orchestrateur sans PRECONDITION ops. |
| **BLOCKS_AUTO_LARGE** | **YES** tant que l’AUTO emprunte un unit cron **sans** protection **prouvée**. |

### 14.2 Autres scénarios — TEST_DEFINED

| ID | Setup / action | Oracle (résultat + interdits) | TESTING | BLOCKS_AUTO_LARGE |
|----|----------------|------------------------------|---------|-------------------|
| Lease valide tout le run | Run unique, lease R1 tenue jusqu’au `release` | Steps s’exécutent selon budget ; **pas** `LEASE_STOLEN` ; `release` par **le même** `ownerRunId` | Partiel EXISTING (stubs/wiring) | NO |
| Expire mid-worker non-Gmail | TTL tombé **pendant** extraction/download/recovery/content | Cible : détection + fail-closed ; **pas** SUCCESS ; pas AUTO. Aujourd’hui : worker **continue** (GAP code) | TEST_DEFINED ; **pas** IMPLEMENTED | **YES** |
| Takeover autre owner | `forceOwner` / `acquire` R2 après R1 | Inter-étapes EXISTING : step suivante `LEASE_STOLEN`. Mid-worker non-Gmail : comme A.(2) | Inter-étapes : IMPLEMENTED partiel. Mid-run non-Gmail : DEFINED only | **YES** mid-run |
| Stale mutation après `LEASE_STOLEN` | Voir A.(2) | Aucune nouvelle mutation critique | DEFINED ; IMPLEMENTED non-Gmail : non | **YES** |
| Heartbeat OK | `renew` tant que `OWNED` | `OWNED`, TTL prolongé. Gmail : page-head **seulement** | Repo : IMPLEMENTED. Worker non-Gmail : DEFINED | **YES** si AUTO longs sans preuve |
| Heartbeat échec | `renew` après steal | ≠ `OWNED` → traiter `LEASE_STOLEN` ; **pas** `acquire` de rattrapage | Repo : IMPLEMENTED | **YES** |
| `assertOwned` avant mutation | Chemins §10 | EXISTING **seulement** inter-étapes et Gmail **page-head**. Cible non-Gmail : TARGET_* | Voir §10 | **YES** AUTO |
| `assertOwned` avant cursor | Gmail `saveSuccessfulPage` | **TBD_TARGET** / `GMAIL_CURSOR_FENCE`. Interdit : tester comme EXISTING aujourd’hui | DEFINED as target | NO (Gmail) / **YES** si sync auto dépend du cursor |
| Extraction orchestrateur | `runDraftExtractionSystem` sous runner `extraction` | Lease au **start** d’étape EXISTING ; mid-run **absent** ; AUTO possible après persist. Cible : §10 TARGET_REQUIRED | DEFINED | **YES** |
| Extraction UI | Voir E | `MECHANISM_NOT_DEFINED` | DEFINED | **YES** |
| Attachment download | Runner / unit cron | Orchestrateur : lease start only. Unit : **sans** lease. Mid-run steal : A–D | DEFINED | **YES** traitements longs |
| Recovery | Idem download + reclaim | Idem | DEFINED | **YES** longs |
| Content fetch | Option A sans claim | Idem ; GAP double-fetch ≠ exactly-once | DEFINED | **YES** longs |
| Booking non-régression | Suites `tests/booking/**` ; pas d’import Acquisition→Booking | **Aucun** changement Booking / `gmail-scan` / cursors / leases / states Booking | EXISTING suites ; 012-4 n’y touche pas | **YES** si violation |

Preuves **impossibles sans runtime** : hang Anthropic réel vs TTL ; vol **pendant** TX déjà ouverte ; staging UI+cron simultané. Restent **TEST_DEFINED** au niveau principe (§11) ; exécution ops = **TBD**.

---

## 15. GO / NO-GO

| ITEM | STATUS | EVIDENCE | BLOCKS_AUTO_LARGE |
|------|--------|----------|-------------------|
| Inventory `STEP_ORDER` (5 workers) | **GO** | `ORCHESTRATOR_STEP_KEYS` ; `createProductionStepRunners` | NO |
| Lease acquire / release / `ownerRunId` | **GO** | lease.repository + types | NO |
| `assertOwned` inter-étapes | **GO** | orchestrator.service + test stolen mid-run **inter-steps** | NO (insuffisant seul) |
| Invariant `leaseTtlMs >= maxDurationMs + safetyMarginMs` | **GO** (atténuation, pas fencing mid-run) | feature-flag orchestrateur | NO si hang / dépassement / UI |
| Heartbeat Gmail orchestrateur | **GO** (référence **`PAGE_BOUNDARY_PARTIAL`**) | `runGmailSync` page-head + fence post-driver ; **pas** fully fenced ; **pas** intra-page ; tests mid-page absents | NO (Gmail seulement ; **insuffisant** AUTO large) |
| Heartbeat recovery / download / content / extraction | **GAP** | `acquisition-orchestrator-workers.ts` ; doc fencing V2 | **YES** |
| `assertOwned` mid-run non-Gmail | **GAP** | runners sans `shouldContinue` | **YES** |
| Fence finale non-Gmail (comme Gmail) | **GAP** | seul gmailSync a le fence final | **YES** |
| Oracles tests §14 A–F | **GO** (**TEST_DEFINED** documentaire) | §14.1 ; **pas** TEST_IMPLEMENTED | **YES** runtime AUTO large tant que non PASSING sur chemins activés |
| Chemin UI extraction sous lease | **NOT_APPLICABLE** / **GAP** concurrence | `runDraftExtraction` | **YES** si UI reste activable pour AUTO |
| Modèle concurrence UI (alternative) | **TBD** | §4 — non inventé | **YES** tant que non résolu |
| Unit crons ∥ orchestrateur | **PRECONDITION** | ops staging : ne pas activer en parallèle | **YES** si violé |
| Contrat `LEASE_STOLEN` cible | **GO** (documentaire §8) | aligné inter-étapes existant | NO pour DONE SPEC ; **YES** runtime AUTO large tant que mid-run non conforme |
| Fréquence heartbeat chiffrée | **TBD** | §9 | NO pour DONE SPEC ; **YES** implémentation sans preuve |
| AUTO / REVIEW 012-0…012-3 | **GO** (préservés) | ce document §12 | **YES** si violés |
| **G-FENCE** | **NO-GO** / **OPEN** | 012-0 §11.2 ; 012-3 §11 | **YES** |
| Booking isolation | **GO** | 012-0 §10 ; 012-4 n’y touche pas | **YES** si violation |
| Activation AUTO large dans ce lot | **NO-GO** | §1 / §17 | **YES** si effectuée |
| Implémentation fencing dans ce lot | **NO-GO** | §17 — aucune | **YES** si effectuée en passant pour « fermer G-FENCE » |
| `FENCING_IMPLEMENTATION_READY` | **NO** / non satisfait | §16.2 | **YES** jusqu’à audit code **et** TEST_PASSING |

Ne **pas** marquer GO le fencing mid-worker non-Gmail : **non prouvé**.

---

## 16. Critère de sortie

### 16.1 PLAN-ACQ-012-4 SPEC DONE

lorsque **tous** les points suivants sont vrais :

- périmètre workers **complet** (`STEP_ORDER` + unit crons + UI) ;
- chemin UI **explicitement** traité (§4) y compris oracle **`MECHANISM_NOT_DEFINED`** ;
- invariants fencing définis (§7) y compris **sérialisation globale** (pas de lease per-company) ;
- Gmail documenté `PAGE_BOUNDARY_PARTIAL` (pas fully fenced) ;
- comportement `LEASE_STOLEN` défini (§8) ;
- stratégie heartbeat / `assertOwned`  **EXISTING** / **TARGET_*** / **TBD** par chemin (§§6, 9, 10) ;
- tests d’acceptation **TEST_DEFINED** avec oracle (setup / action / résultat / interdits) pour **tous** les scénarios critiques §14.1 A–F et §14.2 ;
- **TEST_IMPLEMENTED** / **TEST_PASSING** **non** exigés pour SPEC DONE ;
- GO/NO-GO complet (§15) ;
- gaps explicites (**G-FENCE OPEN**, UI, unit crons, fréquences, mid-run non-Gmail) ;
- **aucune implémentation** effectuée.

**DONE SPEC ≠ fencing livré.**

### 16.2 FENCING_IMPLEMENTATION_READY (ultérieur)

Condition **séparée**, **non satisfaite** ici. Ne déclarer READY **qu’après** audit code **et** tests.

Minimum :

1. Mid-worker fencing (heartbeat et/ou `assertOwned`) sur **chaque** worker orchestré dont la durée n’est **pas** prouvée strictement sous TTL+marge **ou** qui porte AUTO.
2. Perte d’ownership → **LEASE_STOLEN** fail-closed **sans** nouvelle mutation **après** détection, y compris **pas d’AUTO**.
3. Tests §14 **TEST_IMPLEMENTED** **et** **TEST_PASSING** pour extraction / download / recovery / content (pas seulement inter-étapes), plus oracles A–F selon chemins activés.
4. Chemin UI : soit **hors** AUTO, soit modèle de concurrence **documenté et testé** (toujours **TBD** aujourd’hui).
5. Unit crons : soit off quand orchestrateur on, soit fencing équivalent **prouvé**.
6. Booking / `gmail-scan` **intacts**.
7. Re-audit **G-FENCE** — fermeture **seulement** si 012-0 §11.2 est **prouvé**, pas par existence de cette SPEC.

**Statut actuel :** `FENCING_IMPLEMENTATION_READY` = **NO** (non satisfait).

---

## 17. Hors scope

- implémentation fencing
- modification lease / workers / UI extraction
- runtime activation ; autoApprove / autoConvert
- Prisma ; migrations
- Booking ; `/api/cron/gmail-scan`
- Vercel ; Raspberry Pi ; scheduler
- PLAN-ACQ-012-5+
- modification Gmail (au-delà de la description §5)
- ferrer une fréquence heartbeat numérique
- lease orchestrateur **per-company** (HORS SCOPE / TBD)

---

## 18. Mapping 012-0

Ce lot met à jour `docs/plan-acq-012-0-auto-review-guardrails.spec.md` comme suit :

- **mapping fonctionnel** modifié **uniquement** pour **PLAN-ACQ-012-4** (objectif TBD → référence à ce fichier + critère de sortie) ;
- **PLAN-ACQ-012-5 … 012-7 inchangés** (restent TBD) ;
- une **entrée d’historique documentaire** 012-0 peut également être ajoutée (n’est **pas** un mapping de lot, n’altère pas G-FENCE).

**G-FENCE** ligne §16 de 012-0 : **inchangée** (**OPEN**).

---

## Historique

| Date | Note |
|------|------|
| 2026-08-15 | Création SPEC 012-4 (DOC ONLY) HEAD `d0e05b90` ; G-FENCE reste OPEN |
| 2026-08-16 | R1 — `PAGE_BOUNDARY_PARTIAL` Gmail ; oracles tests A–F ; release `ownerRunId` ; wording mapping 012-0 |
