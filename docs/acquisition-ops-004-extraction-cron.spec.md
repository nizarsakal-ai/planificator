# PLAN-ACQ-OPS-004-SPEC

| Champ | Valeur |
|-------|--------|
| **Identifiant** | PLAN-ACQ-OPS-004-SPEC |
| **Version** | 1.1.0 (R1) |
| **Statut** | Normatif — consolidé après SPEC-REVIEW-001 |
| **Module** | Worker cron Extraction Acquisition |
| **Bases** | PLAN-ACQ-OPS-004-AUDIT ; PLAN-ACQ-OPS-004-SPEC ; PLAN-ACQ-OPS-004-SPEC-REVIEW-001 ; PLAN-ACQ-OPS-003-SPEC-R1 ; PLAN-ACQ-OPS-001-SPEC ; ENGINEERING-STANDARD-001 ; PLAN-GOVERNANCE-001 ; moteur 005B sur `main` |
| **Autorité métier extraction** | PLAN-ACQ-005B — `runDraftExtraction` (unique) |
| **Date** | 2026-07-22 |

---

## 0. Décisions structurelles inchangées (R1)

- OPS-004 automatise **uniquement** l’orchestration du moteur 005B.
- `runDraftExtraction` reste l’**unique** autorité métier.
- Réutilisation du claim existant `EXTRACTING` + `version` + reclaim TTL.
- Aucun second moteur d’extraction.
- Aucun `force=true` dans le cron.
- `PENDING_REVIEW` exclu du worker automatique.
- Flag dédié `ACQUISITION_EXTRACTION_CRON_ENABLED`.
- Scheduler externe uniquement ; **aucun** ajout dans `vercel.json`.
- **NO MIGRATION REQUIRED** (clarifiée §15).

---

## 1. Périmètre

### 1.1 Ce que fait OPS-004

1. Route cron sécurisée hors `vercel.json`.
2. Handler + gates flags.
3. Orchestrateur multi-tenant borné (sélection, budgets, agrégation).
4. Wrapper système vers le cœur 005B (sans faux ADMIN).
5. Observabilité run + tests + documentation.

### 1.2 Ce que OPS-004 ne fait pas

- Redéfinir providers, Anthropic, Zod, normalize, persist métier.
- Review / Conversion / OPS-005 / Booking / logements / `gmail-scan`.
- Table FetchState extraction / seconde machine d’état.
- Re-extract automatique de `PENDING_REVIEW`.
- Activation prod / configuration scheduler.
- Suppression ou branchement de `extractWorksiteImportDraft` (§14).

---

## 2. Autorité métier 005B (normatif)

### 2.1 Unique autorité — `runDraftExtraction` (cœur métier)

Seule autorité pour :

- vérifier l’éligibilité **unitaire** ;
- effectuer le claim ;
- incrémenter `extractionAttemptCount` ;
- passer le draft à `EXTRACTING` ;
- gérer le reclaim stale ;
- vérifier le content hash ;
- appeler le provider ;
- normaliser et valider le résultat ;
- persister l’extraction ;
- passer à `PENDING_REVIEW` ou `FAILED` ;
- produire les outcomes métier (`ExtractDraftResult`).

### 2.2 Orchestrateur OPS-004 — autorisé uniquement à

- sélectionner des candidats (lecture) ;
- appliquer les budgets ;
- appeler le **wrapper système** 005B ;
- agréger les outcomes ;
- journaliser les résultats du run.

### 2.3 Orchestrateur — interdit

- écrire directement les statuts du draft ;
- incrémenter les attempts ;
- reclaimer directement ;
- persister le résultat d’extraction ;
- reproduire les règles de transitions 005B ;
- reclassifier un échec comme « permanent » avant la politique 005B.

---

## 3. Architecture

```text
GET /api/cron/acquisition-extraction
        ↓
Handler (CRON_SECRET → 401 sinon ; avant toute I/O)
        ↓
Gates flags (§11)
        ↓
Orchestrateur (budgets §8, file §4)
        ↓
Wrapper système 005B (§3.1)
        ↓
Cœur métier runDraftExtraction (005B)
```

### 3.1 Wrapper système sans faux ADMIN

| Entrée | Contrat |
|--------|---------|
| **Core métier** | Logique commune claim/provider/persist (factorisation minimale dans `extraction.service.ts`) |
| **Wrapper UI** | Inchangé : session + rôles `ADMIN` \| `SUPER_ADMIN` + `companyId` session (`reExtractImportDraftAction` / chemins UI existants) |
| **Wrapper système** | `companyId` + `draftId` (+ horloge optionnelle) ; **aucun** Role ; appelé **uniquement** après auth cron réussie |

Interdit :

- faux utilisateur / rôle artificiel ;
- `skipAuth` générique ;
- `companyId` ou `draftId` fournis par la requête HTTP client ;
- tenants / drafts non déterminés côté serveur.

Le wrapper système et l’UI appellent **le même** cœur métier 005B.

---

## 4. File d’extraction normative

### 4.1 Éligibilité — toutes les conditions

| # | Condition |
|---|-----------|
| F1 | `draft.companyId` = `companyId` du tenant traité |
| F2 | `status ∈ { PENDING_EXTRACTION, FAILED }` **ou** (`EXTRACTING` **et** stale selon reclaim TTL 005B) |
| F3 | Content présent pour `(acquisitionMessageId, companyId)` |
| F4 | `normalizedText` non vide |
| F5 | Message et draft du même tenant (FK / filtre `companyId`) |
| F6 | `extractionAttemptCount < maxAttempts` (même borne que 005B). Un `EXTRACTING` stale n’est sélectionnable que si cette borne est respectée ; le reclaim effectif reste **confirmé par 005B** |
| F7 | Retry dû (§5) — pour `FAILED` : voir §5.2 ; pour `PENDING_EXTRACTION` : pas de contrainte `lastExtractionErrorAt` ; pour `EXTRACTING` stale : pas de backoff d’erreur (reclaim TTL suffit) |
| F8 | Draft **non déjà traité** dans le run courant |

### 4.2 Exclusions explicites

- `PENDING_REVIEW`, `APPROVED`, `REJECTED`, `CONVERTED`
- tout appel avec `force=true`
- content absent ou vide
- `extractionAttemptCount >= maxAttempts`
- `EXTRACTING` **non** stale

### 4.3 Ordre et isolation

- FIFO : `draft.createdAt ASC`, tie-breaker `draft.id ASC`
- Requêtes **tenant-scopées**
- Aucune agrégation globale cross-tenant coûteuse
- Aucun `companyId` issu du client

### 4.4 Règle impérative

> Un draft ne peut être envoyé à `runDraftExtraction` (via wrapper système) **qu’une seule fois par run** OPS-004.

Même si 005B renvoie `RETRY_ALLOWED`, **aucun** second appel du même draft dans ce run.

---

## 5. Backoff sans migration (`NO MIGRATION REQUIRED`)

Champs utilisés : `lastExtractionErrorAt`, `extractionAttemptCount`, `lastExtractionErrorCode` (observabilité).

### 5.1 Index de tentative

La tentative pour le backoff est la valeur **persistée** de `extractionAttemptCount` **après** le dernier échec 005B (incrément déjà effectué au claim de cette tentative).

Formule normative :

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
| ≥ 5 | 15 min (plafond) |

### 5.2 Éligibilité retry — draft `FAILED`

Toutes les conditions :

1. `lastExtractionErrorAt IS NOT NULL`
2. `extractionAttemptCount < maxAttempts`
3. `now >= lastExtractionErrorAt + backoff(extractionAttemptCount)`

Si `lastExtractionErrorAt IS NULL` sur un `FAILED` : **non** éligible automatiquement (pas de retry dû). Cas à traiter Ops / investigation — pas de drain spéculatif.

### 5.3 Effacement au claim (comportement 005B réel)

Le claim 005B remet à `null` : `lastExtractionErrorAt`, `lastExtractionErrorCode`.

Cette remise à zéro survient **après** que la sélection a déjà validé le retry dû (F7) et **après** un claim réussi.
Elle **ne casse pas** le backoff de sélection, calculé **avant** l’appel 005B.

### 5.4 Compromis documenté

`nextExtractionRetryAt` serait plus lisible. Les champs existants suffisent de façon **déterministe**. Une migration n’apporte pas de garantie d’intégrité supplémentaire **nécessaire** à ce lot → **NO MIGRATION REQUIRED**.

---

## 6. Retry, poison pills, conduite dérivée de 005B

### 6.1 Principe

Aucune terminalité parallèle inventée par OPS-004.
Conduite = mapping exclusif des **outcomes réels** `ExtractDraftResult`.

### 6.2 Outcomes de course / état — **normaux** (pas erreurs système)

| Outcome | Compteur batch |
|---------|----------------|
| `EXTRACTED` | `extracted` |
| `ALREADY_EXTRACTED` | `alreadyExtracted` |
| `IN_PROGRESS` | `inProgress` |
| `STATE_CHANGED` | `stateChanged` |
| `STALE_CONTENT` | `staleContent` |
| `CONTENT_MISSING` | `contentMissing` |
| `MAX_ATTEMPTS_REACHED` | `maxAttemptsReached` |
| `RETRY_ALLOWED` | `retryAllowed` |

### 6.3 Autres échecs métier / provider

Codes et statut `FAILED` / `RETRY_ALLOWED` produits par 005B restent l’autorité.
OPS-004 incrémente `failed` (ou le compteur dédié ci-dessus si l’outcome matche) **sans** reclasse « permanent » précoce.

### 6.4 Poison pill

Exclusion automatique de la file lorsque :

`extractionAttemptCount >= maxAttempts`

Réactivation = **uniquement** voie UI humaine (+ `force` si politique UI) — **jamais** le cron.

### 6.5 Provider non configuré

Détecté **une seule fois** avant la boucle candidats (résolution provider / équivalent 005B sans spam).

| Situation | Statut run |
|-----------|------------|
| Aucun candidat encore traité avec succès | `FAILED` |
| Au moins un succès / traitement utile déjà agrégé | `PARTIAL` |

Aucun appel provider par candidat si la config globale rend toute extraction impossible.

---

## 7. Reclaim stale

Sélection d’un `EXTRACTING` **uniquement si** :

1. `extractionStartedAt < now - reclaimTTL` (TTL = `getExtractionReclaimTtlMs` 005B) ;
2. `extractionAttemptCount < maxAttempts` ;
3. le moteur 005B **confirme** le reclaim via son claim (sinon outcome `IN_PROGRESS` / équivalent).

L’orchestrateur **ne modifie jamais** statut ni version.
`EXTRACTING` non stale : exclu de la sélection (ou, si course, `IN_PROGRESS` sans force).

---

## 8. Budgets et timeout provider

| Paramètre | Défaut figé |
|-----------|-------------|
| `maxCompaniesPerRun` | 20 |
| `maxPerCompany` | 10 |
| `maxPerRun` | 50 |
| `maxDurationMs` | 240_000 |
| `safetyMarginMs` | 5_000 |
| `providerTimeoutMs` | **lu** via la même config 005B (`getExtractionTimeoutMs`) — **non dupliqué** arbitrairement |
| Route `maxDuration` | 300 s |

### 8.1 Règle obligatoire avant chaque candidat

> Ne pas démarrer une extraction (ne pas appeler le wrapper système) si le temps restant du run est **strictement inférieur** à `providerTimeoutMs + safetyMarginMs`.

Alors : arrêt propre, statut run `PARTIAL`, candidats restants pour un futur run.

Aucun appel Anthropic ne démarre si la plateforme risque raisonnablement de couper avant le timeout prévu.

Ordre tenants : `companyId` ASC déterministe. Arrêt avant **nouveau** candidat (pas d’annulation mid-persist 005B une fois claim réussi).

---

## 9. Outcomes batch et compteurs

### 9.1 Statuts de run

| Status | Sémantique |
|--------|------------|
| `SKIPPED` | Gate OFF |
| `SUCCESS` | Run terminé dans le budget ; aucun échec technique bloquant global ; pas de budget atteint |
| `PARTIAL` | Budget atteint, et/ou candidat/tenant en échec isolé, et/ou throw isolé, et/ou provider config après succès partiel |
| `FAILED` | Impossibilité globale (ex. provider non configuré avant tout succès ; échec listing global) |

### 9.2 Compteurs minimums

`companiesSelected`, `companiesProcessed`, `selected`, `extracted`, `alreadyExtracted`, `inProgress`, `stateChanged`, `staleContent`, `contentMissing`, `retryAllowed`, `maxAttemptsReached`, `failed`, `unexpectedFailed`, `skipped`, `durationMs`

(+ agrégats companies Succeeded / Partial / Failed / Skipped si utile, sans remplacer les compteurs outcome).

### 9.3 Mapping

Chaque valeur de `ExtractDraftResult` (succès ou échec) a **exactement un** mapping compteur.
**Aucun double comptage.**

---

## 10. Concurrence

### 10.1 Cron / cron

Deux workers sélectionnent le même draft → 005B tranche via claim/version → un seul extrait → l’autre : `IN_PROGRESS` / `STATE_CHANGED` (ou équivalent) → aucune double persistance, aucune corruption de version.

### 10.2 UI / cron

Aucune priorité implicite → claim 005B tranche → perdant : outcome **normal** → pas d’erreur système.

### 10.3 État modifié après sélection

| Course | Outcome attendu (005B) |
|--------|------------------------|
| Passe `PENDING_REVIEW` | `ALREADY_EXTRACTED` ou `STATE_CHANGED` |
| Hash content changé | `STALE_CONTENT` |
| maxAttempts atteint | `MAX_ATTEMPTS_REACHED` |
| Claim concurrent | `IN_PROGRESS` |

Comptés comme résultats **normaux** de concurrence.

---

## 11. Feature flags

Flag : `ACQUISITION_EXTRACTION_CRON_ENABLED` (`=== "true"` ; défaut OFF).

### Ordre des gates

1. `CRON_SECRET` → 401
2. flag cron extraction → `CRON_DISABLED`
3. master Acquisition → `MASTER_DISABLED`
4. content capability → `CONTENT_FETCH_DISABLED`
5. extraction capability → `EXTRACTION_DISABLED`
6. orchestrateur

Flags OFF ⇒ **zéro** listing métier / **zéro** mutation.

### Invariants (validation pure, distincte des gates)

- `INV_EXTRACTION_CRON_WITHOUT_MASTER`
- `INV_EXTRACTION_CRON_WITHOUT_CONTENT`
- `INV_EXTRACTION_CRON_WITHOUT_EXTRACTION`

Couper le cron **ne coupe pas** l’extraction manuelle UI.

---

## 12. Throws inattendus (discipline OPS-003)

Chaque appel wrapper système isolé **par candidat**.

Sur throw :

- ne pas interrompre les autres candidats / tenants ;
- pas de stack / prompt / body / réponse Anthropic / token ;
- log `EXTRACTION_UNEXPECTED_FAILURE` ;
- `unexpectedFailed++` ;
- run → `PARTIAL` ;
- **aucun** retry immédiat du même draft dans le run.

Erreur globale de config **avant** la boucle → `FAILED` (sauf succès déjà agrégés → `PARTIAL`, §6.5).

---

## 13. Observabilité

### Événements minimums

`EXTRACTION_CRON_SKIPPED`, `EXTRACTION_RUN_STARTED`, `EXTRACTION_DRAFT_EXTRACTED`, `EXTRACTION_DRAFT_ALREADY_EXTRACTED`, `EXTRACTION_DRAFT_IN_PROGRESS`, `EXTRACTION_DRAFT_STATE_CHANGED`, `EXTRACTION_DRAFT_STALE_CONTENT`, `EXTRACTION_DRAFT_CONTENT_MISSING`, `EXTRACTION_DRAFT_RETRY_ALLOWED`, `EXTRACTION_DRAFT_MAX_ATTEMPTS`, `EXTRACTION_DRAFT_FAILED`, `EXTRACTION_UNEXPECTED_FAILURE`, `EXTRACTION_RUN_FINISHED`

### Champs autorisés

`companyId`, `draftId`, `acquisitionMessageId`, `outcome`, `errorCode` sûr, `provider`, `durationMs`, `contentHashPrefix` borné

### Interdits

Texte email, prompt complet, réponse brute provider, token, clé API, subject, sender, stack brute

---

## 14. Action orpheline

**Décision normative :** `extractWorksiteImportDraft` reste **hors périmètre** OPS-004.

- ne pas supprimer ;
- ne pas réutiliser comme wrapper cron ;
- ne pas modifier son contrat ;
- ne pas la connecter à l’UI dans ce lot.

Le worker utilise une **entrée système dédiée** dans `extraction.service.ts`.
Nettoyage de l’action orpheline = lot distinct.

---

## 15. Migration

**NO MIGRATION REQUIRED**

Justification : claim `EXTRACTING` + version + reclaim TTL + `extractionAttemptCount` + `lastExtractionErrorAt` / `Code` + `maxAttempts` + backoff calculable avant claim + poison via plafond d’attempts. Aucun second état persistant nécessaire.

---

## 16. Allowlist prévisionnelle stricte

### Créations autorisées

- `src/app/api/cron/acquisition-extraction/route.ts`
- flag / config cron extraction (voisin `src/lib/acquisition/extraction/`)
- handler, orchestrateur, types, repository de **sélection** (lecture seule) si nécessaire
- `docs/acquisition-ops-004-*.md` (+ maj `acquisition-ops-001-flags.md`)
- `tests/acquisition/*extraction*cron*` (et extensions flags)

### Modifications autorisées

- `extraction.service.ts` — wrapper système / factor AuthZ **uniquement**
- `acquisition-flag-matrix.ts` + tests matrice
- `package.json` — wiring scripts tests uniquement
- types cron transversaux **strictement** nécessaires (`AcquisitionCronSkipReason` élargi si besoin)

### Interdits

Booking / logements / `gmail-scan` / `vercel.json` / OPS-003 runtime / OPS-005 / providers Anthropic / prompts / schémas Zod / normalisation / Review / Conversion / Prisma schema & migrations / `.env*` / scheduler Raspberry Pi / deps npm sans justification

---

## 17. Tests obligatoires

### Unitaires

Gates, INV, mapping exhaustif outcomes, budgets, `providerTimeoutMs + safetyMarginMs`, backoff dû/non dû, attempt off-by-one, maxAttempts, reclaim stale, throw candidat, continuation run, un seul appel par draft/run, provider non configuré.

### Route

401 avant I/O ; chaque gate OFF ; flags valides → orchestrateur **une** fois ; zéro listing / mutation avant gates.

### PostgreSQL

Sélection tenant-scopée ; FIFO ; content présent ; retry dû / non dû ; maxAttempts exclu ; `EXTRACTING` stale / non stale ; double claim cron/cron ; UI/cron ; version conflict ; stale content ; `ALREADY_EXTRACTED` ; aucune double persistance ; isolation A/B ; cleanup fiable.

### Stress

Plusieurs workers ; répétitions ≥ 3 ; aucune corruption version ; aucune double extraction persistée ; aucune fuite tenant ; pas de flaky inexpliqué.

---

## 18. Critères d’acceptation

OPS-004 terminé seulement si :

1. Worker extraction auto fonctionnel
2. 005B unique autorité
3. Flags OFF = zéro mutation
4. Aucun faux ADMIN
5. Multi-tenant prouvé
6. Claim/reclaim prouvé
7. Backoff prouvé
8. maxAttempts empêche les boucles
9. Un appel max par draft/run
10. Concurrence cron/cron et UI/cron prouvée
11. Outcomes 005B conservés dans les compteurs
12. Throws isolés
13. Budget provider respecté
14. Tests unitaires + PG + stress verts
15. Documentation alignée
16. Scheduler externe **non** présenté comme actif
17. Rollback = flag cron OFF
18. PRR GO (hors merge code seul)

---

## 19. Scheduler / rollback

- Fréquence cible : Ops (ex. après content) — **non configurée** dans ce lot.
- Rollback runtime : `ACQUISITION_EXTRACTION_CRON_ENABLED ≠ true` (ou master / content / extraction OFF) ; UI extract inchangée si capacité ON.

---

## 20. Références

PLAN-ACQ-OPS-004-AUDIT, PLAN-ACQ-OPS-004-SPEC-REVIEW-001, PLAN-ACQ-005B, PLAN-ACQ-OPS-001, PLAN-ACQ-OPS-002, PLAN-ACQ-OPS-003-SPEC-R1, ENGINEERING-STANDARD-001, PLAN-GOVERNANCE-001

---

READY FOR IMPLEMENTATION
