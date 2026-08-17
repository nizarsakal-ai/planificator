# PLAN-ACQ-012-4 — Non-Gmail Worker Fencing

| Champ | Valeur |
|-------|--------|
| **Ticket** | PLAN-ACQ-012-4 |
| **Type** | SPEC normative fencing / concurrence Acquisition **non-Gmail** |
| **Statut** | POST-IMPLEMENTATION — aligné PR #53 (revue APPROVE) |
| **HEAD de référence** | `a04f635a5a49888c060003e5de3e316ea54dad85` (main, merge PR #53) |
| **Sources normatives** | `docs/plan-acq-012-0-auto-review-guardrails.spec.md` ; `docs/plan-acq-012-1-auto-review-adoption.spec.md` ; `docs/plan-acq-012-2-auto-approve-pilot.spec.md` ; `docs/plan-acq-012-3-auto-convert-controlled.spec.md` |
| **Source technique existante** | `docs/acquisition-ops-v2-fencing-workers.md` |
| **Lot SPEC historique** | Documentation only — n’a **pas** livré le code |
| **Lot implémentation** | **PR #53 MERGED** — `a04f635a5a49888c060003e5de3e316ea54dad85` ; revue indépendante **APPROVE** (BLOCKING 0, MAJOR 0, MINOR 1 cycle import) |
| **Activation runtime** | **Toujours interdite** par ce document (`AUTO_RUNTIME_STATUS = OFF`) |

| Champ fencing | Valeur post-PR #53 |
|----------------|-------------------|
| **G-FENCE** | **CLOSED** (012-0 §11.2 — fencing mid-worker non-Gmail **orchestré** satisfait) |
| **FENCING_IMPLEMENTATION_READY** | **YES** |
| **TEST_IMPLEMENTED** | **YES** |
| **TEST_PASSING** | **YES** |
| **UI_GAP** | **CLOSED** (séparation `UI_MANUAL` — **pas** de lease UI) |
| **UNIT_CRON_GAP** | **PRECONDITION_ONLY** (hors lease ; AUTO interdit ; dual ∥ orchestrateur = discipline OPS) |
| **GMAIL_CURRENT_FENCING** | **PAGE_BOUNDARY_PARTIAL** (inchangé ; hors fermeture G-FENCE non-Gmail) |
| **GMAIL_CURSOR_FENCE** | **TBD_TARGET** |
| **AUTO_RUNTIME_STATUS** | **OFF** |

**G-FENCE CLOSED** ne signifie **pas** : AUTO_APPROVE activé, AUTO_CONVERT activé, pilote 012-2/012-3 exécuté, OPS-007 publié, production runtime ready.

---

## 1. Rôle

PLAN-ACQ-012-4 **définit** le contrat de concurrence / fencing Acquisition requis **avant toute activation automatique large**.

Deux lots distincts :

1. **Lot SPEC historique** — documentation only. N’a **pas** implémenté le fencing, n’a **pas** fermé G-FENCE, n’a **pas** livré de tests. DONE SPEC ≠ fencing livré.
2. **Lot implémentation** — **PR #53** mergé en `a04f635`. Livraison fencing non-Gmail orchestré + tests. **G-FENCE CLOSED** au sens 012-0 §11.2. **Aucune** activation AUTO.

Ce document reflète l’**état réel** après PR #53, **sans** sur-déclarer la granularité (frontière d’item / draft, pas fence continu).

### 1.1 Problème à couvrir

Une **lease** orchestrateur (`acquisition_orchestrator_leases`) peut **expirer** pendant qu’un worker continue son traitement.

Un autre orchestrateur peut alors **acquérir** la même lease (`key` globale `acquisition-orchestrator`).

Il faut empêcher qu’un **worker devenu stale** continue à produire des **effets métier non autorisés**.

La solution a été livrée par **PR #53** (`PLAN-ACQ-V2-FENCING-WORKERS` / wiring `createProductionStepRunners` INTERNAL). Ce document **n’active pas** AUTO.

### 1.2 Portée documentaire actuelle

| Inclus | Exclu |
|--------|-------|
| Contrat fencing **réel** non-Gmail orchestré (frontière item/draft) | Fence Gmail intra-page / `FULLY_FENCED` |
| UI `UI_MANUAL` (AUTO interdit) | Lease UI |
| Unit crons **PRECONDITION_ONLY** | UNIT_CRON FENCED |
| Tests **TEST_PASSING** 25/25 | Activation AUTO / OPS-007 |
| Limites §11 (post-I/O, pas exactly-once) | Lease per-company |

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
| **MID-WORKER FENCING** | Contrôle d’ownership **pendant** une étape (`runners[key]`), pas seulement **entre** deux clés de `STEP_ORDER`. **Gmail** : `GMAIL_CURRENT_FENCING` = `PAGE_BOUNDARY_PARTIAL` (§5) — **pas** fully fenced. **Non-Gmail orchestré (PR #53)** : frontière d’**item** / **draft** (`assertOwned` + `renew`) — **pas** fence continu ni intra-item post-I/O. |
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
| `runAcquisitionOrchestrator` (`acquisition-orchestrator.service.ts`) → `GET /api/cron/acquisition-orchestrator` | `acquire({ key: "acquisition-orchestrator", ownerRunId: runId, leaseTtlMs })`. `ALREADY_RUNNING` → run `SKIPPED`. | **Non** (pas de `renew` dans la boucle d’étapes) | **Oui entre étapes**. Après vol : stop des étapes suivantes. `finally` : `release` ; si `NOT_OWNER` et déjà stolen, pas `leaseReleaseFailed`. | Logs `[acquisition-orchestrator]` ; statut run ; **pas** de mutation métier directe | **PROUVÉ inter-étapes**. Mid-worker : **délégué aux runners** (Gmail page-bound ; non-Gmail item-bound PR #53). |

Chemin production AUTO (PR #53) : `handleAcquisitionOrchestratorCron` → `runProductionAcquisitionOrchestrator` → **une** autorité `acquisitionOrchestratorLeaseRepository` pour `acquire` / `assertOwned` / `renew` / `release` **et** mint des capabilities workers. **Aucun** `reacquire` de rattrapage. **Aucun** paramètre repository injecté par le caller. Factory AUTO publique = **NONE**. Capability = identité opaque ; heartbeat réel dans WeakMap privé (`resolveOrchestratorAutoOwnership`). `{ ensureOwned: async () => "OWNED" }` → **NOT_OWNED** (fail-closed).

### 3.2 Workers orchestrés

| PATH | LEASE AT START | HEARTBEAT MID-RUN | ASSERT OWNED MID-RUN | SIDE EFFECTS | CURRENT FENCING STATUS |
|------|----------------|-------------------|----------------------|--------------|------------------------|
| **gmailSync** `createProductionStepRunners.gmailSync` → `runGmailSync` → `runAcquisitionGmailSyncDriver` → `syncAcquisitionMailForCompany` | Hérite lease parent (`ownerRunId` = `runId`) | **Page-head seulement** : `shouldContinue` → deadline `Date.now()` + `assertOwned` + `renew` si présent. **Pas** un heartbeat intra-page / après chaque I/O | **Page-head** via `shouldContinue` ; **fence final après le driver** (donc **après** mutations éventuelles de la dernière page). **Pas** d’`assertOwned` avant chaque ingest / `saveSuccessfulPage` | Ingestion messages ; shadow ; cursor `lastHistoryId` (`saveSuccessfulPage` si pagination **complète** succès) ; logs `[acquisition-orchestrator:gmail]` | **`PAGE_BOUNDARY_PARTIAL`**. **Pas** fully fenced. **Pas** INTRA_PAGE_FENCED. §5. **Hors** fermeture G-FENCE non-Gmail. |
| **attachmentRecovery** `runAcquisitionAttachmentRecoveryOrchestrator` | Inter-étape + capability orchestrateur | **Oui — frontière d’item** : `assertOwned` puis `renew` via `ensureOwnership` (capability WeakMap) **avant** chaque reclaim / retry. **Pas** un timer. **Pas** après chaque I/O interne. | **Oui avant chaque item** ; **pas** pendant l’I/O déjà lancé | Reclaim `PENDING_DOWNLOAD` stale ; retry download ; logs `RECLAIM_*` / recovery | **EXISTING inter-items**. I/O déjà lancé non annulé. Effets partiels conservés. |
| **attachmentDownload** `runAcquisitionAttachmentDownloadOrchestrator` → `downloadAcquisitionAttachment` | Idem | **Oui — frontière d’item** : heartbeat `assertOwned`+`renew` **avant** chaque PJ. **Pas** fence après HTTP/storage intra-item. | **Oui avant chaque item** ; **pas** pendant `downloadAttachment` | `claimForDownload` ; fetch ; persist `STORED` / retry/reject | **EXISTING inter-items**. Pas atomicité lease+persist. |
| **contentFetch** `runAcquisitionContentCronOrchestratorDefault` | Idem | **Oui — frontière d’item** (message) : heartbeat **avant** chaque fetch. **Pas** après HTTP avant persist interne. | **Oui avant chaque item** | Fetch contenu ; persist hash/texte ; état retry (**Option A sans claim**) | **EXISTING inter-items**. Double-fetch possible hors claim métier ; idempotence bornée ≠ exactly-once. |
| **extraction** `runAcquisitionExtractionCronOrchestrator` → `runDraftExtractionOrchestrated` → `runDraftExtractionCore` → hook AUTO **si** ownership encore valide | Idem | **Oui — frontière de draft** + fences **avant persist** (après provider) et **avant AUTO**. Heartbeat = `assertOwned`+`renew` via WeakMap. `renew` absent → fail-closed. | **Oui** avant claim ; après provider **avant** persist ; après persist **avant** AUTO | Claim `EXTRACTING`+version ; persist `PENDING_REVIEW` / FAILED ; hook AUTO **uniquement** `ORCHESTRATOR_AUTO` + capability authentique (`AUTO_RUNTIME_STATUS` **OFF**) | **EXISTING inter-drafts** + fences persist/AUTO. Perte **avant** persist → pas de persist. Perte **après** persist → persist conservé, AUTO non appelé, `LEASE_STOLEN`, parent ≠ SUCCESS. |
| **UI extraction** — voir §4 | **Aucune lease orchestrateur** (**NOT_APPLICABLE**) | **Non** | **Non** | Core + AuthZ ADMIN/SUPER_ADMIN. Contexte **`UI_MANUAL`** | **UI_GAP CLOSED** par séparation : extraction OK → `PENDING_REVIEW` → review manuelle ; **AUTO interdit**. **Pas** de lease UI. |
| **Unit crons** `/api/cron/acquisition-attachment-recovery` \| `…-download` \| `…-content-fetch` \| `…-extraction` \| `…-gmail-sync` | **Aucune** lease `acquisition-orchestrator` | **Non** (Gmail unit : pas le `shouldContinue` orchestrateur) | **Non** (pas de fencing orchestrateur) | Mêmes workers métier. Extraction unit → `runDraftExtractionSystem` / **`UNIT_CRON`** | **UNIT_CRON_GAP = PRECONDITION_ONLY**. **AUTO interdit**. **Ne pas écrire UNIT_CRON FENCED.** Dual unit cron ∥ orchestrateur = **discipline OPS**, pas un mutex code. |

Aucun autre runner n’est câblé dans `AcquisitionOrchestratorStepRunners`.

---

## 4. Chemin UI extraction

Chemin réel :

1. `extractWorksiteImportDraft` (`src/lib/actions/acquisition-extraction.actions.ts`) **et/ou** revue → `runDraftExtraction` (`acquisition-review.actions.core.ts`)
2. `runDraftExtraction` (`extraction.service.ts`) — flags + AuthZ `ADMIN` \| `SUPER_ADMIN`
3. `runDraftExtractionCore` avec contexte **`UI_MANUAL`** (fixe — **aucune** capability orchestrateur acceptée)
4. extraction OK → **`PENDING_REVIEW`** → **review manuelle**
5. `maybeRunAutoDecisionAfterExtraction` : **interdit** sur ce chemin (même si flags AUTO env étaient ON)

**`UI_GAP` = CLOSED** par **séparation de chemin**, **pas** par une lease UI.

| Question | Statut post-PR #53 |
|----------|-------------------|
| Lease orchestrateur | **NOT_APPLICABLE** — **non utilisée** ; **aucune** lease UI n’existe |
| Heartbeat / `renew` | **Absent** (pas de lease) |
| `assertOwned` | **Absent** — un test qui l’exige en UI **échoue la SPEC** |
| Concurrence extraction UI | Claim draft `EXTRACTING` + version (optimistic) ; reclaim TTL `EXTRACTING` orphelin (défaut 5 min) |
| AUTO | **Interdit** (`UI_MANUAL`). Ne bloque **plus** AUTO large : ce chemin **ne peut plus** déclencher AUTO |
| Mécanisme lease UI futur | **MECHANISM_NOT_DEFINED** — uniquement pour un **éventuel** modèle de lease UI ; **non requis** tant que AUTO reste interdit sur UI |

**BLOCKS_AUTO_LARGE (chemin UI)** = **NO**. 012-3 « un seul chemin sous lease sans traiter l’UI » est satisfait par **interdiction AUTO UI**, pas par emprunt de lease.

Preuve : `tests/acquisition/plan-acq-012-4-fencing.test.ts` (UI + capability forgée ignorée / AUTO non appelé).

---

## 5. Gmail (référence uniquement)

Gmail **n’est pas modifié** par 012-4.

**`GMAIL_CURRENT_FENCING` = `PAGE_BOUNDARY_PARTIAL`.** Meilleure référence Gmail, **explicitement partielle**. **Ne pas** présenter Gmail comme `FULLY_FENCED` ni `INTRA_PAGE_FENCED`. **Gmail est hors** de la fermeture **G-FENCE** non-Gmail (012-0 §11.2).

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
| Risque si lease expirée | Stale run **peut** encore terminer un item **déjà lancé** (I/O non annulé). Après **détection** à la frontière suivante : **pas** de nouvelle mutation critique ; **pas** d’AUTO |
| Besoin heartbeat | **EXISTING** frontière de draft : `assertOwned` puis `renew` (capability WeakMap). Fréquence timer : **TBD** (pas de `heartbeatIntervalMs`) |
| Besoin `assertOwned` avant mutation | **EXISTING** avant claim ; **EXISTING** après provider **avant** persist ; **EXISTING** avant AUTO. **PAS** pendant l’appel provider / TX persist |
| Si ownership perdu | **EXISTING** §8 : fail-closed `LEASE_STOLEN` ; pas SUCCESS ; pas AUTO ; persist déjà committé **conservé** ; **pas** de reacquire |

### 6.2 attachment download

| Critère | Constat |
|---------|---------|
| Durée potentielle | Défaut 240s ; I/O réseau + storage par PJ ; boucle companies/PJ avec `isTimeBudgetExceeded` **seulement** (pas lease) |
| Side effects | Claim download ; objet storage ; statut `STORED` / retry / reject |
| Points de mutation | `claimForDownload` ; persist download |
| Risque si lease expirée | Item **déjà lancé** peut aller jusqu’à persist `STORED`. Frontière suivante : stop. Atténué **partiellement** par claim PJ ≠ lease |
| Besoin heartbeat | **EXISTING** frontière d’item (`assertOwned`+`renew`). **Pas** post-HTTP/storage intra-item |
| Besoin `assertOwned` avant mutation | **EXISTING** avant chaque item download. **NOT_CURRENTLY_GUARANTEED** pendant `downloadAttachment` |
| Si ownership perdu | Stop ; pas SUCCESS ; effets déjà `STORED` **conservés** (idempotence `ALREADY_STORED`) |

### 6.3 attachment recovery

| Critère | Constat |
|---------|---------|
| Durée potentielle | Défaut 240s ; phases RECLAIM puis RETRY |
| Side effects | `reclaimPendingDownload` (retour `DISCOVERED`) ; retries = download |
| Points de mutation | Statuts PJ ; compteurs retry |
| Risque si lease expirée | Reclaim **déjà lancé** non rollbacké. Frontière d’item suivante : stop. Courses TTL reclaim PJ (défaut 20 min) **≠** TTL lease |
| Besoin heartbeat | **EXISTING** frontière d’item |
| Besoin `assertOwned` avant mutation | **EXISTING** avant chaque reclaim / retry. **Pas** pendant l’opération item |
| Si ownership perdu | Stop fail-closed ; reclaim déjà fait **non rollbacké** |

### 6.4 content fetch

| Critère | Constat |
|---------|---------|
| Durée potentielle | Défaut 240s ; fetch provider par message ; `BUDGET_MARGIN_MS` interne |
| Side effects | Contenu normalisé + hash ; état d’erreur/retry cron |
| Points de mutation | Tables content / fetch-state — **pas de claim** (Option A) |
| Risque si lease expirée | Fetch **déjà lancé** peut persister. Frontière suivante : stop. **Plus élevé** hors claim métier (Option A) |
| Besoin heartbeat | **EXISTING** frontière d’item (message) |
| Besoin `assertOwned` avant mutation | **EXISTING** avant chaque item. **NOT_CURRENTLY_GUARANTEED** pendant HTTP/persist interne |
| Si ownership perdu | Stop ; persist déjà commité **conservé** ; retries compatibles duplication hash / `ALREADY_PRESENT` (≠ exactly-once) |

### 6.5 Autres

AUTO n’est **pas** un worker : hook post-extraction. Sous orchestrateur : **EXISTING** — appelé seulement si `ORCHESTRATOR_AUTO` + capability WeakMap encore `OWNED`. UI / UNIT_CRON : **jamais**. Flags AUTO : **OFF**.

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
9. Ce contrat s’applique au **chemin orchestrateur**. Le chemin **UI** est **`UI_MANUAL`** : extraction possible, **AUTO interdit**, lease UI **NOT_APPLICABLE**. Un éventuel modèle de lease UI futur reste **MECHANISM_NOT_DEFINED** — il **ne bloque plus** AUTO large.
10. **Portée lease** : une seule clé `"acquisition-orchestrator"` **sérialise les runs orchestrateurs globalement**, **pas** par `companyId`. Un modèle per-company est **HORS SCOPE / TBD**.

**Interdit** d’écrire dans une implémentation future une règle incompatible avec :

- persist extraction (relecture hash + update `EXTRACTING`+version) ;
- conversion `updateMany` `APPROVED`+version ;
- cursor Gmail « persist seulement après pagination complète succès ».

---

## 8. LEASE_STOLEN

Comportement **EXISTING** post-PR #53 (inter-étapes + mid-worker non-Gmail **frontière d’item/draft** + Gmail fence final). Distinguer **NOT_CURRENTLY_GUARANTEED** : intra-page Gmail, intra-item post-I/O, I/O déjà lancé.

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

Heartbeat **NOT_APPLICABLE** sur le chemin UI (pas de lease) — AUTO y est **interdit** (`UI_MANUAL`). **Pas** applicable tel quel aux unit crons (pas de lease orchestrateur ; **PRECONDITION_ONLY**).

### 9.2 Fréquence relative au TTL

**Aucune valeur de période n’est figée ici.**

Il n’existe pas de `heartbeatIntervalMs` dans le code. Gmail renouvelle **par page**, pas sur un timer.

Toute fréquence numérique (fraction de TTL, intervalle fixe) = **TBD** jusqu’à preuve (mesure durée page/item **ou** intention d’implémentation dédiée hors ce lot).

Borne qualitative (non chiffrée) : un `renew` doit intervenir **avant** expiration **si** le worker continue ; spam `renew` à chaque micro-mutation **non exigé**.

### 9.3 Opérations longues

| Opération | Heartbeat |
|-----------|-----------|
| Boucle Gmail pages | **EXISTING page-head seulement** (`PAGE_BOUNDARY_PARTIAL`). **Pas** un heartbeat après chaque I/O / ingest intra-page |
| Download I/O + storage | **EXISTING** frontière d’item (`assertOwned`+`renew` **avant** l’item). **NOT_CURRENTLY_GUARANTEED** intra-item / post-HTTP |
| Recovery reclaim/retry boucle | **EXISTING** frontière d’item |
| Content fetch HTTP + persist | **EXISTING** frontière d’item. **NOT_CURRENTLY_GUARANTEED** pendant HTTP/persist |
| Appel provider extraction (jusqu’à 60s) | **EXISTING** : fence **après** provider **avant** persist. **N’annule pas** l’appel en cours (§11) |
| `maybeRunAutoDecisionAfterExtraction` | **EXISTING** : fence WeakMap **avant** AUTO ; UI/UNIT_CRON **jamais** AUTO |

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
| attachmentRecovery mid-run | **EXISTING** avant chaque item reclaim/retry. **NOT_CURRENTLY_GUARANTEED** pendant l’opération item | **EXISTING** à la frontière d’item suivante. **Pas** un fence continu | **NOT_APPLICABLE** | **NOT_APPLICABLE** | **NOT_APPLICABLE** |
| attachmentDownload mid-run | **EXISTING** avant chaque PJ. **NOT_CURRENTLY_GUARANTEED** pendant `downloadAttachment` | Idem frontière d’item suivante | **NOT_APPLICABLE** | **NOT_APPLICABLE** | **NOT_APPLICABLE** |
| contentFetch mid-run | **EXISTING** avant chaque message. **NOT_CURRENTLY_GUARANTEED** pendant HTTP/persist | Idem | **NOT_APPLICABLE** | **NOT_APPLICABLE** | **NOT_APPLICABLE** |
| extraction orchestrateur mid-run | **EXISTING** avant claim. Granularité **draft** | **EXISTING** après provider **avant** persist | **NOT_APPLICABLE** | **EXISTING** (capability WeakMap). Fake `{ ensureOwned }` → NOT_OWNED | **EXISTING** si AUTO (flags **OFF**) : même fence ; pas d’AUTO si `LEASE_STOLEN` |
| extraction UI | **NOT_APPLICABLE** (pas de lease UI) | **NOT_APPLICABLE** | **NOT_APPLICABLE** | **CLOSED** : AUTO **interdit** (`UI_MANUAL`). Lease UI futur : **MECHANISM_NOT_DEFINED** | **CLOSED** : AUTO **interdit** |
| Unit crons | **NOT_APPLICABLE** vis-à-vis de **cette** lease. **UNIT_CRON_GAP = PRECONDITION_ONLY**. Extraction unit = `UNIT_CRON` (**AUTO interdit**). Dual ∥ orchestrateur = discipline OPS. **Pas UNIT_CRON FENCED** | **NOT_APPLICABLE** | **NOT_APPLICABLE** (sauf unité Gmail : pas de `shouldContinue` orchestrateur) | **CLOSED** pour AUTO (interdit). Dual run métier : **PRECONDITION** ops | **CLOSED** pour AUTO |

**Cible AUTO sous orchestrateur (EXISTING) :** ne **pas** appeler `maybeRunAutoDecisionAfterExtraction` sur un run **stale**. Authentification : WeakMap privé — **pas** `capability.ensureOwned()` comme preuve.

**UI / unit cron :** un test **ne doit pas** supposer `assertOwned` / lease. AUTO y est **interdit** (contextes `UI_MANUAL` / `UNIT_CRON`). Dual unit cron ∥ orchestrateur reste **PRECONDITION** ops — **pas** un fencing code.

---

## 11. Transactions et limites

Garanties **bornées** :

| Affirmation | Conséquence |
|-------------|-------------|
| Un `assertOwned` **avant** TX ne protège pas une expiration **pendant** la TX | Fenêtre résiduelle acceptée ; **pas** fence continu ; TX doivent rester **courtes** |
| Un `renew` **externe** n’interrompt pas une TX ni un HTTP déjà lancé | Heartbeat ≠ cancellation I/O du provider |
| Fencing ≠ rollback global | Effets commités restent ; voir §8. **Partial effects** possibles |
| Idempotence ≠ fencing ≠ exactly-once | `ALREADY_*` / version **limitent les dégâts**, n’empêchent pas un stale d’**essayer** un item déjà lancé |
| Optimistic concurrency ≠ lease ownership | `EXTRACTING`+version, `claimForDownload` : mutex **ressource**. Lease : mutex **run orchestrateur global** |
| Lease globale ≠ isolation tenant | Deux companies dans **le même** run partagent **une** lease. UI n’est **pas** fencée par la lease (AUTO UI interdit) |

Ne pas documenter un « stop the world » ou un abort Prisma depuis heartbeat.

---

## 12. AUTO / REVIEW

012-0 … 012-3 **préservés intégralement**.

| ID | Statut après PR #53 |
|----|---------------------|
| **G-FENCE** | **CLOSED** — précondition 012-0 §11.2 (fencing mid-worker **non-Gmail orchestré**) **satisfaite**. Granularité = **frontière d’item/draft** (`assertOwned`+`renew`). **Pas** Gmail fully fenced (`PAGE_BOUNDARY_PARTIAL`). **Pas** unit crons leased. **Pas** fence continu intra-item. **`AUTO_RUNTIME_STATUS = OFF`**. |
| G-INV, G-RB, G-MASTER-SERVICE-SCOPE | Inchangés (**ouverts**) |
| P-ACTOR, P-CONV, P-STAGE | Inchangés |
| Critères AUTO_APPROVE_ONLY / AUTO_APPROVE_CONVERT / HUMAN_REVIEW_REQUIRED | **Non modifiés** |
| Flags `=== "true"` | Inchangés. `ACQUISITION_AUTO_APPROVE_ENABLED` / `ACQUISITION_AUTO_CONVERT_ENABLED` **non activés** par 012-4 |

**G-FENCE CLOSED** **n’autorise pas** une activation automatique large, un pilote 012-2/012-3 runtime, ni OPS-007. Il **lève uniquement** le blocage fencing §11.2.

012-4 **n’autorise pas** de réinterpréter un pilote borné 012-2/012-3 comme GO fencing **ou** GO AUTO.

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

Ce **lot SPEC historique** visait **TEST_DEFINED**. Après **PR #53** :

| État | Sens | Statut post-PR #53 |
|------|------|-------------------|
| **TEST_DEFINED** | Oracles §14 | **YES** (SPEC) |
| **TEST_IMPLEMENTED** | `tests/acquisition/plan-acq-012-4-fencing.test.ts` | **YES** |
| **TEST_PASSING** | Vert sur HEAD `a04f635` | **YES** — **25/25** PASS |

Autres preuves de non-régression (revue PR #53, **pas** un typecheck global vert) :

- Acquisition complète : **708/708** PASS
- Booking unit : **269/269** PASS
- Typecheck : **aucune nouvelle erreur Acquisition** ; **15** erreurs Booking `ProcessEnv` / `NODE_ENV` **préexistantes** (identiques au HEAD de base) — **ne pas** les transformer en PASS global typecheck

Ancrages complémentaires : `acquisition-orchestrator.service.test.ts`, `acquisition-orchestrator-lease.test.ts`.

**Contrat lease 012-4 :** sérialisation **globale** (`key = "acquisition-orchestrator"`). **Pas** de lease per-company.

### 14.1 Oracles critiques

#### A. Concurrence — même company — TEST_DEFINED

| Champ | Oracle |
|-------|--------|
| Setup | Company C. Run orchestrateur R1 : `acquire` OK, `ownerRunId=R1`. Worker W (extraction / download / recovery / content selon le cas) **en cours** pour C. |
| Action | Lease perdue pour R1 (expire **ou** `acquire` par R2). W stale **détecte** la perte (`assertOwned`/`renew` ≠ `OWNED`, une fois le fencing mid-run **ciblé** en place). W tente une **nouvelle** mutation critique. Un second `runAcquisitionOrchestrator` (même C) pendant que R1 tient encore la lease. |
| Résultat attendu | (1) Second run tant que lease R1 valide : `SKIPPED` / `ALREADY_RUNNING`, steps `NOT_RUN`. **Pas** une lease per-company. (2) Après détection de perte : W **n’autorise aucune nouvelle mutation critique** (fail-closed / `LEASE_STOLEN`). |
| Effets interdits | Re-`acquire` silencieux par W. Succès d’étape après détection. AUTO decision/convert après détection. Inventer une clé par `companyId`. |
| Statut | Orchestrateur : `PARTIAL` si `LEASE_STOLEN`. Mid-worker non-Gmail (frontière item/draft) : **TEST_IMPLEMENTED** + **TEST_PASSING** |
| **BLOCKS_AUTO_LARGE** | **NO** pour le **gap fencing 012-0 §11.2**. **YES** encore pour flags OFF / 012-2/012-3 runtime / OPS-007 (hors G-FENCE). |

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
| Résultat attendu | Effets **déjà commités restent**. **Aucun rollback global**. Après **détection** (frontière d’item/draft) : **aucune** nouvelle mutation critique par le stale. Fenêtre **avant** détection (intra-page Gmail ; item **déjà lancé**) : **NOT_CURRENTLY_GUARANTEED**. `GMAIL_CURSOR_FENCE` = **TBD_TARGET**. |
| Effets interdits | Delete/revert automatique des lignes déjà persistées. Exactement-une-fois universel. |
| Statut | **TEST_IMPLEMENTED** / **TEST_PASSING** (extraction persist conservé + AUTO skip ; recovery/download/content inter-items). |
| **BLOCKS_AUTO_LARGE** | **NO** pour G-FENCE. AUTO flags toujours **OFF**. |

#### D. Retry après lease loss — TEST_DEFINED

| Champ | Oracle |
|-------|--------|
| Setup | Après C : état persistant réel (claims, `ALREADY_*`, versions, contenu hash). |
| Action | **Nouveau** run `ownerRunId` valide, **même** company / mêmes items. |
| Résultat attendu | Reprise **selon l’état persistant**, via mécanismes **déjà** présents (claim draft/PJ, `ALREADY_STORED` / `ALREADY_EXTRACTED` / logs `CONTENT_FETCH_ALREADY_PRESENT`, `ALREADY_CONVERTED`). **Aucun** rollback implicite du run perdu. **Aucune** garantie universelle exactly-once. |
| Effets interdits | Dupliquer au-delà des filets **déjà** documentés 012-0/012-3. Rejouer AUTO si les gates l’interdisent encore. |
| Si idempotence worker **non prouvée** | Oracle = **GAP** **borné** (pas un bloqueur G-FENCE) : content Option A sans claim — upsert/P2002 **≠** exactly-once. |
| **BLOCKS_AUTO_LARGE** | **YES** pour un worker AUTO si GAP idempotence **non** traité. |

#### E. UI extraction vs cron / orchestrateur — TEST_DEFINED

| Champ | Oracle |
|-------|--------|
| Setup | Appel `runDraftExtraction` (Server Action ou revue). **Pas** de `runAcquisitionOrchestrator`. |
| Action | (1) Observer lease / `assertOwned`. (2) Extraction OK → `maybeRunAutoDecisionAfterExtraction` **si** flags (aujourd’hui OFF). |
| Résultat attendu | **Aucune** lease orchestrateur. Contexte **`UI_MANUAL`**. Extraction OK → `PENDING_REVIEW`. **Aucun** `maybeRunAutoDecisionAfterExtraction`. `assertOwned` **absent** — un test qui l’exige en UI **échoue**. |
| Oracle actuel | **`UI_GAP = CLOSED`** (séparation). Lease UI : **NOT_APPLICABLE**. **MECHANISM_NOT_DEFINED** seulement pour un **éventuel** modèle lease UI futur. |
| Effets interdits | Supposer une lease UI. Forcer `acquire` dans la Server Action. AUTO UI. |
| **BLOCKS_AUTO_LARGE** | **NO** — le chemin UI **ne peut plus** déclencher AUTO. |

#### F. Unit crons — TEST_DEFINED

| Champ | Oracle |
|-------|--------|
| Setup | `GET /api/cron/acquisition-gmail-sync` \| `…-attachment-recovery` \| `…-attachment-download` \| `…-content-fetch` \| `…-extraction` **sans** passer par `/api/cron/acquisition-orchestrator`. |
| Action | Exécuter le handler (gates peuvent SKIPPED). Inspecter lease / `shouldContinue` / `assertOwned`. |
| Résultat attendu | **Aucune** lease `acquisition-orchestrator`. **Aucun** fencing orchestrateur. Extraction unit : `runDraftExtractionSystem` / **`UNIT_CRON`** — **AUTO interdit**. Gmail unit : **pas** de `shouldContinue` orchestrateur. Dual unit cron ∥ orchestrateur = **discipline OPS** (`acquisition-ops-v2-staging-activation.md`). **Ne pas écrire UNIT_CRON FENCED.** |
| Effets interdits | Traiter un unit cron SUCCESS comme preuve de fencing. Inventer un mutex/fencing unit. |
| **BLOCKS_AUTO_LARGE** | **NO** pour AUTO (interdit sur UNIT_CRON). Dual run métier : **PRECONDITION_ONLY**. |

### 14.2 Autres scénarios — TEST_DEFINED

| ID | Setup / action | Oracle (résultat + interdits) | TESTING | BLOCKS_AUTO_LARGE |
|----|----------------|------------------------------|---------|-------------------|
| Lease valide tout le run | Run unique, lease R1 tenue jusqu’au `release` | Steps selon budget ; **pas** `LEASE_STOLEN` ; `release` **même** `ownerRunId` ; **même autorité** acquire/assert/renew/release | **TEST_PASSING** (provenance production) | NO pour G-FENCE |
| Expire mid-worker non-Gmail | TTL / steal **à la frontière** extraction/download/recovery/content | Détection + fail-closed ; **pas** SUCCESS ; pas AUTO. Item **déjà lancé** peut finir (post-I/O non garanti) | **TEST_IMPLEMENTED** / **TEST_PASSING** | NO pour G-FENCE |
| Takeover autre owner | `acquire` R2 après R1 | Inter-étapes + item-bound : `LEASE_STOLEN`. **Pas** de reacquire | **TEST_PASSING** | NO pour G-FENCE |
| Stale mutation après `LEASE_STOLEN` | Voir A.(2) | Aucune **nouvelle** mutation critique **après détection** | **TEST_PASSING** | NO pour G-FENCE |
| Heartbeat OK | `renew` tant que `OWNED` | `OWNED`, TTL prolongé. Non-Gmail : **par item/draft**. Gmail : page-head **seulement** | **TEST_PASSING** | NO pour G-FENCE |
| Heartbeat échec | `renew` absent ou ≠ OWNED | fail-closed `NOT_OWNED` / `LEASE_STOLEN` ; **pas** `acquire` | **TEST_PASSING** | NO pour G-FENCE |
| `assertOwned` avant mutation | Chemins §10 | EXISTING inter-étapes, Gmail page-head, non-Gmail **frontière item/draft** | Voir §10 | NO pour G-FENCE |
| `assertOwned` avant cursor | Gmail `saveSuccessfulPage` | **TBD_TARGET** / `GMAIL_CURSOR_FENCE`. Interdit : tester comme EXISTING | DEFINED as target | NO (Gmail hors G-FENCE non-Gmail) |
| Extraction orchestrateur | `runDraftExtractionOrchestrated` + capability WeakMap | Fences claim / persist / AUTO ; fake capability rejetée | **TEST_PASSING** | NO pour G-FENCE ; flags AUTO **OFF** |
| Extraction UI | Voir E | `UI_MANUAL` ; AUTO interdit | **TEST_PASSING** | **NO** |
| Attachment download | Runner orchestré / unit cron | Orchestrateur : **EXISTING** inter-items. Unit : **sans** lease (**PRECONDITION_ONLY**) | **TEST_PASSING** (orchestrateur) | NO G-FENCE ; unit dual = PRECONDITION |
| Recovery | Idem + reclaim | **EXISTING** inter-items orchestré | **TEST_PASSING** | Idem |
| Content fetch | Option A sans claim | **EXISTING** inter-items ; GAP exactly-once inchangé | **TEST_PASSING** | Idem |
| Capability forgée | `{ ensureOwned: OWNED }` JS | `LEASE_STOLEN` ; pas persist ; pas AUTO | **TEST_PASSING** | NO |
| Booking non-régression | `tests/booking/**` ; pas d’import Acquisition→Booking | **Aucun** changement Booking / `gmail-scan` | **269/269** unit PASS ; 15 err. tsc Booking **préexistantes** | **YES** si violation |

Preuves **impossibles sans runtime** : hang Anthropic réel vs TTL ; vol **pendant** TX déjà ouverte ; staging UI+cron simultané. Restent **TEST_DEFINED** au niveau principe (§11) ; exécution ops = **TBD**.

---

## 15. GO / NO-GO

| ITEM | STATUS | EVIDENCE | BLOCKS_AUTO_LARGE |
|------|--------|----------|-------------------|
| Inventory `STEP_ORDER` (5 workers) | **GO** | `ORCHESTRATOR_STEP_KEYS` ; `createProductionStepRunners` **INTERNAL** | NO |
| Lease acquire / release / `ownerRunId` | **GO** | Même singleton `acquisitionOrchestratorLeaseRepository` par construction | NO |
| `assertOwned` inter-étapes | **GO** | orchestrator.service | NO |
| Invariant `leaseTtlMs >= maxDurationMs + safetyMarginMs` | **GO** (atténuation) | feature-flag orchestrateur | NO si hang |
| Heartbeat Gmail orchestrateur | **GO** **`PAGE_BOUNDARY_PARTIAL`** | page-head + fence post-driver ; **pas** fully fenced ; **pas** intra-page | NO (Gmail hors G-FENCE non-Gmail) |
| Heartbeat recovery / download / content / extraction | **GO** frontière item/draft | PR #53 ; tests 25/25 | NO pour G-FENCE |
| `assertOwned` mid-run non-Gmail | **GO** frontière item/draft | `ensureOwnership` + WeakMap | NO pour G-FENCE |
| Capability AUTO opaque + WeakMap | **GO** | mint INTERNAL ; fake `{ ensureOwned }` rejeté | NO |
| No reacquire | **GO** | heartbeat ≠ acquire | NO |
| Oracles tests §14 | **TEST_IMPLEMENTED** + **TEST_PASSING** | `plan-acq-012-4-fencing.test.ts` 25/25 | NO pour G-FENCE |
| Chemin UI | **UI_GAP CLOSED** | `UI_MANUAL` ; AUTO interdit ; lease **NOT_APPLICABLE** | **NO** |
| Unit crons | **PRECONDITION_ONLY** | HORS lease ; AUTO interdit ; dual ∥ = OPS | Dual métier : **YES** si violé |
| Contrat `LEASE_STOLEN` | **GO** EXISTING | persist conservé ; AUTO skip ; parent ≠ SUCCESS | NO pour G-FENCE |
| Fréquence heartbeat chiffrée | **TBD** | pas de `heartbeatIntervalMs` | NO pour G-FENCE |
| AUTO / REVIEW 012-0…012-3 | **GO** (préservés) | `AUTO_RUNTIME_STATUS = OFF` | **YES** si flags ON sans 012-2/012-3 |
| **G-FENCE** | **CLOSED** | 012-0 §11.2 prouvé PR #53 | **NO** (fencing). Activation AUTO : autres gaps |
| Booking isolation | **GO** | PR #53 n’y touche pas | **YES** si violation |
| Activation AUTO / flags | **NO-GO** | OFF | **YES** si effectuée |
| `FENCING_IMPLEMENTATION_READY` | **YES** | §16.2 ; revue APPROVE | NO pour G-FENCE |
| `OPS_007_STATUS` | **NOT_CREATED** | 012-5 / G-RB | **YES** activation ops documentée |

Intra-item post-I/O, Gmail cursor, exactly-once : **non GO** — limites §5 / §11. **Ne pas** marquer Gmail fully fenced.

---

## 16. Critère de sortie

### 16.1 PLAN-ACQ-012-4 SPEC DONE (lot SPEC historique)

Critère **historique** du lot documentation : oracles **TEST_DEFINED**, **aucune implémentation dans le lot SPEC**. **DONE SPEC ≠ fencing livré.** Conservé pour l’historique ; **ne pas** réécrire comme si la SPEC avait livré le code.

### 16.2 FENCING_IMPLEMENTATION_READY

**Statut actuel :** `FENCING_IMPLEMENTATION_READY` = **YES** (PR #53, HEAD `a04f635`, revue APPROVE).

Minimum §16.2 — **satisfait** au sens suivant :

1. Mid-worker non-Gmail orchestré : heartbeat `assertOwned`+`renew` **frontière d’item/draft** sur recovery / download / content / extraction (AUTO).
2. Perte d’ownership → `LEASE_STOLEN` fail-closed ; pas d’AUTO ; persist déjà commis conservé.
3. Tests §14 **TEST_IMPLEMENTED** + **TEST_PASSING** (`plan-acq-012-4-fencing.test.ts` **25/25**).
4. UI : **hors AUTO** (`UI_MANUAL`) — lease UI **non** inventée.
5. Unit crons : AUTO interdit ; dual ∥ orchestrateur = **PRECONDITION** ops (**pas** fenced).
6. Booking / `gmail-scan` **intacts**.
7. **G-FENCE CLOSED** au sens 012-0 §11.2 (prouvé par le code + tests, pas par la SPEC seule).

**Pas** satisfait / **hors** READY : Gmail intra-page ; `GMAIL_CURSOR_FENCE` ; fence continu ; cancellation I/O ; unit cron leased ; AUTO flags ON.

### 16.3 Known limitation (MINOR)

Cycle d’import `acquisition-orchestrator-workers` ↔ `extraction.service` : **MINOR** accepté par la revue indépendante. Non bloquant ; **aucun bypass** observé.

---

## 17. Hors scope (restant)

- activation runtime ; `ACQUISITION_AUTO_APPROVE_ENABLED` / `ACQUISITION_AUTO_CONVERT_ENABLED` ON
- pilotes runtime 012-2 / 012-3
- publication OPS-007 / fermeture **G-RB**
- Prisma ; migrations ; scheduler ; Vercel ; Raspberry Pi
- Booking ; `/api/cron/gmail-scan`
- modification Gmail au-delà du constat `PAGE_BOUNDARY_PARTIAL`
- `GMAIL_CURSOR_FENCE` (TBD_TARGET)
- fence continu / cancellation I/O / exactly-once
- lease orchestrateur **per-company**
- fencing unit cron (interdit d’en inventer)
- PLAN-ACQ-012-6 / 012-7 TBD

---

## 18. Mapping 012-0

Alignement **post-PR #53** :

- **G-FENCE** ligne §16 de 012-0 : **CLOSED** (sens §11.2 uniquement)
- §11.1 heartbeat non-Gmail : **EXISTING** frontière d’item/draft
- mapping PLAN-ACQ-012-4 : `TEST_IMPLEMENTED` / `TEST_PASSING` dans le dépôt
- **G-INV**, **G-RB**, **G-MASTER-SERVICE-SCOPE**, **P-ACTOR**, **P-CONV**, **P-STAGE** : **inchangés**
- PLAN-ACQ-012-6 … 012-7 : **TBD inchangé**
- **012-5** : `OPS_007_STATUS = NOT_CREATED` ; `OPS_007_READY = NO` ; **G-RB OPEN**

---

## Historique

| Date | Note |
|------|------|
| 2026-08-15 | Création SPEC 012-4 (DOC ONLY) HEAD `d0e05b90` ; G-FENCE OPEN |
| 2026-08-16 | R1 — `PAGE_BOUNDARY_PARTIAL` Gmail ; oracles tests A–F ; release `ownerRunId` ; wording mapping 012-0 |
| 2026-08-17 | PR #53 MERGED `a04f635` — implémentation fencing non-Gmail ; revue APPROVE (BLOCKING 0, MAJOR 0, MINOR 1 cycle import) |
| 2026-08-17 | Documentation closure : G-FENCE CLOSED ; FENCING_IMPLEMENTATION_READY YES ; TEST 25/25 ; AUTO_RUNTIME OFF ; Gmail reste PAGE_BOUNDARY_PARTIAL |
