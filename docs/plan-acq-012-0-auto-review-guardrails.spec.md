# PLAN-ACQ-012-0 — Auto / Review Guardrails

| Champ | Valeur |
|-------|--------|
| **Ticket** | PLAN-ACQ-012-0 |
| **Type** | SPEC normative (documentation seule) |
| **Statut** | DRAFT — prêt pour revue R2 |
| **HEAD de référence** | `31397257901aa0f9c1cf425299d7dae645a157ae` (main, post PR #52) |
| **Implémentation** | **Interdite** dans ce lot |
| **Activation runtime** | **Interdite** dans ce lot |

---

## 1. Statut et rôle de la SPEC

Ce document est la **SPEC canonique** des garde-fous Acquisition pour la décision **AUTO** vs **HUMAN REVIEW**, et pour l’activation progressive des lots suivants `PLAN-ACQ-012-1` … `PLAN-ACQ-012-7`.

Il **fige** le comportement **réel** du code existant (sources §3) et les préconditions d’activation.

**Règle d’écriture :** aucune garantie normative ne doit être plus forte que ce que le code prouve. Si une règle souhaitée n’est pas enforceée partout, elle est marquée **GAP** ou **PRECONDITION**.

Ce lot **NE DOIT PAS** :

- activer ou modifier des flags runtime ;
- modifier le métier Acquisition, Booking, Gmail, Prisma, migrations ;
- réimplémenter policy, conversion, orchestrateur, registre, readiness ;
- introduire une dépendance Acquisition → Booking ;
- déployer, scheduler, ou changer Vercel / Raspberry Pi.

Ce lot **DOIT** uniquement produire / corriger ce document (et, ultérieurement, son adoption en revue).

Les mécanismes listés §3 existent déjà. PLAN-ACQ-012-0 les **documente**, ne les recrée pas.

---

## 2. Clarification de nomenclature

| Identifiant | Signification | Statut |
|-------------|---------------|--------|
| `PLAN-ACQ-012-LOT-1.x` (ex. 1.2, 1.3, 1.4, 1.5) | Anciens lots **registre partenaires** (bootstrap, repository, readiness, admin) | **Réalisés** dans le dépôt |
| `PLAN-ACQ-012-0` | SPEC garde-fous AUTO / REVIEW + gouvernance d’activation | **Ce document** |
| `PLAN-ACQ-012-1` … `PLAN-ACQ-012-7` | Nouvelle séquence de **gouvernance / preuves / activation contrôlée** | À spécifier / exécuter après 012-0 |

**Règles de nommage :**

1. `PLAN-ACQ-012-LOT-1.x` et `PLAN-ACQ-012-0…7` sont des **séries distinctes**.
2. Aucune relation implicite de **migration**, de **remplacement** ou de **renumérotation** entre elles.
3. Les lots `012-LOT-1.x` **restent** la référence historique du registre ; ils ne sont pas « obsolétés » par 012-0.
4. Dans PR, commits, docs et tickets : toujours utiliser le **nom complet** (`PLAN-ACQ-012-0`, `PLAN-ACQ-012-LOT-1.5`, etc.) — jamais « 012 » seul.

---

## 3. Sources de vérité code existantes

Chemins vérifiés sur le HEAD de référence. **Ne pas inventer** de fichiers hors cette liste pour invoquer une garantie.

### 3.1 Flags / gates / matrice

| Rôle | Fichier |
|------|---------|
| Master kill-switch (helper) | `src/lib/acquisition/acquisition-feature-flag.ts` |
| Matrice flags + `INV_*` | `src/lib/acquisition/acquisition-flag-matrix.ts` |
| Gmail cron flag | `src/lib/acquisition/acquisition-gmail-cron-feature-flag.ts` |
| Auto approve / convert / min confidence / system actor env | `src/lib/acquisition/policy/auto-decision-feature-flag.ts` |
| Conversion brut + fully | `src/lib/acquisition/conversion/conversion-feature-flag.ts` |
| Gate orchestrateur (cron → master) | `src/lib/acquisition/orchestrator/acquisition-orchestrator-gate.ts` |
| Flags orchestrateur (lease TTL, stubs, durée) | `src/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag.ts` |
| Doc ops flags | `docs/acquisition-ops-001-flags.md` |

Convention booléenne runtime : uniquement `process.env.<FLAG> === "true"` (sensible à la casse). Absents / autres valeurs = **OFF**.

### 3.2 Orchestrateur / lease / fencing

| Rôle | Fichier |
|------|---------|
| Service orchestrateur + `assertOwned` inter-étapes | `src/lib/acquisition/orchestrator/acquisition-orchestrator.service.ts` |
| Workers + heartbeat Gmail (`shouldContinue` / `renew`) | `src/lib/acquisition/orchestrator/acquisition-orchestrator-workers.ts` |
| Repository lease | `src/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository.ts` |
| Doc fencing mid-worker | `docs/acquisition-ops-v2-fencing-workers.md` |

### 3.3 Registre / policies partenaires / readiness

| Rôle | Fichier |
|------|---------|
| Repository registre | `src/lib/acquisition/persistence/partner-registry.repository.ts` |
| Admin policies (`updatePartnerPolicy`) | `src/lib/acquisition/admin/partner-admin.service.ts` |
| Schéma admin policies | `src/lib/acquisition/admin/partner-admin.schema.ts` |
| Readiness registre | `src/lib/acquisition/partner-registry-readiness.ts` |
| Readiness staging E2E (Lot C) | `src/lib/acquisition/ops/acquisition-staging-readiness.ts` |
| Cutover / runbook staging | `docs/acquisition-partner-registry-cutover.md`, `docs/acquisition-ops-v2-staging-activation.md` |
| Modèle Prisma (défauts OFF) | `prisma/schema.prisma` — model `AcquisitionPartner` (`autoApproveEnabled`, `autoConvertEnabled`, `allowCreateClient` `@default(false)`) |

### 3.4 Auto-decision / journal / system actor

| Rôle | Fichier |
|------|---------|
| Policy pure AUTO vs REVIEW | `src/lib/acquisition/policy/auto-decision.policy.ts` |
| Exécution post-extraction + journal | `src/lib/acquisition/policy/auto-decision.service.ts` |
| Journal décisions | `src/lib/acquisition/policy/decision-journal.repository.ts` |
| Validation actor SYSTEM | `src/lib/acquisition/policy/system-actor.ts` |
| Hook post-extraction | `src/lib/acquisition/extraction/extraction.service.ts` (`maybeRunAutoDecisionAfterExtraction`) |

### 3.5 Review / conversion / matching

| Rôle | Fichier |
|------|---------|
| Review humaine / approve versionné | `src/lib/acquisition/review/import-draft-review.service.ts` |
| Conversion APPROVED → CONVERTED | `src/lib/acquisition/conversion/conversion.service.ts` |
| Matching client + détection doublon heuristique | `src/lib/acquisition/matching/client-match.service.ts` (`findDuplicateWorksite`) |

### 3.6 Sync Gmail / ingestion / clés message

| Rôle | Fichier |
|------|---------|
| Sync + gates d’entrée + cursor | `src/lib/acquisition/connector/acquisition-gmail-sync.service.ts` |
| Ingestion / `registerIncomingMessage` / `buildAttachmentKey` | `src/lib/acquisition/acquisition.service.ts` |
| Port ingestion `isEnabled` (master) | `src/lib/acquisition/ports/acquisition-ingestion.adapter.ts` |

### 3.7 Isolation Booking (constat structurel)

| Constat | Preuve |
|---------|--------|
| Aucun import `@/lib/booking` sous `src/lib/acquisition` | Audit structurel HEAD de référence |
| Pipeline Booking distinct (`/api/cron/gmail-scan`, `src/lib/booking/**`) | Hors périmètre Acquisition |

---

## 4. Invariants fail-closed

Ces règles sont **normatives** pour toute activation `PLAN-ACQ-012-*`. Elles reflètent le code §3 sauf mention **GAP** / **PRECONDITION**.

| # | Invariant | Périmètre de garantie | Référence |
|---|-----------|----------------------|-----------|
| F1 | Flag absent ou ≠ `"true"` ⇒ OFF | Helpers flag documentés | `*-feature-flag.ts`, OPS-001 |
| F2 | Master OFF ⇒ les **entrées / gates / workers explicitement gated** n’exécutent pas le pipeline métier prévu | **Borné aux chemins gated** — pas un invariant universel par service | Voir §4.1 |
| F3 | Pas d’identité partenaire active ⇒ pas de scan large (`NO_ACTIVE_PARTNER_IDENTITIES`) | Chemin provider Gmail après tentative de list | adapter / sync |
| F4 | Partner `autoApproveEnabled` OFF (ou partner non résolu selon règles service) ⇒ pas d’auto-approve effectif ; policy → `HUMAN_REVIEW_REQUIRED` + reason `AUTO_APPROVE_DISABLED` | `maybeRunAutoDecisionAfterExtraction` | service ∩ policy |
| F5 | Env `ACQUISITION_AUTO_APPROVE_ENABLED` OFF ⇒ early return du service auto-decision (aucun approve via ce chemin) | Ce service uniquement | `auto-decision.service.ts` |
| F6 | Actor SYSTEM non OK ⇒ **aucun** approve / convert auto via ce chemin ; journal avec `decisionCode: "SYSTEM_ACTOR_INVALID"` | Service auto-decision | §6.5 vocabulaire |
| F7 | `allowCreateClient` OFF ⇒ aucun client **NEW** en auto-convert ; conversion **EXISTING** n’en dépend pas | Service auto-decision | §7 |
| F8 | Doublon **détecté** par l’algo courant ⇒ policy `POTENTIAL_DUPLICATE` → REVIEW ; double-check peut bloquer convert | Heuristique bornée | §4.2 / matching |
| F9 | Ambiguïté client / adresse / warnings bloquants / low confidence ⇒ `HUMAN_REVIEW_REQUIRED`, jamais code AUTO policy | Policy pure | `auto-decision.policy.ts` |
| F10 | Combinaisons `INV_*` détectées par la matrice | **Détection seule** | `validateAcquisitionFlagMatrix` |

### 4.1 Master kill-switch — portée réelle (F2)

**Formulation normative bornée :**

- `PLANIFICATOR_ACQUISITION_ENABLED` est un kill-switch **d’entrée** pour les routes / orchestrateurs / workers / services qui appellent explicitement `isAcquisitionEnabled()` (ou un gate qui l’inclut).
- Exemples de chemins **gated** : gate orchestrateur (`MASTER_DISABLED`) ; sync via `ingestion.isEnabled()` → SKIPPED `FEATURE_DISABLED` ; extraction service (checks master avant traitement).
- Un **service interne** appelé directement **n’est pas nécessairement** protégé par le master :
  - `registerIncomingMessage()` **ne vérifie pas** le master en interne (commentaire « les points d’entrée devront vérifier » ; re-export seulement) ;
  - `maybeRunAutoDecisionAfterExtraction()` gate sur `ACQUISITION_AUTO_APPROVE_ENABLED`, **pas** sur le master.
- La protection opérationnelle repose sur les **chemins d’entrée documentés** (cron → gate → worker → services), pas sur un enforcement universel dans chaque fonction.

**Ne jamais** présenter `PLANIFICATOR_ACQUISITION_ENABLED` comme invariant enforceé dans chaque service Acquisition.

**GAP — G-MASTER-SERVICE-SCOPE :** le master n’est pas enforceé dans chaque service interne. Pas d’implémentation demandée par cette SPEC.

### 4.2 Anti-doublon — portée réelle (F8)

`findDuplicateWorksite()` (`client-match.service.ts`) :

- détection **heuristique** (clé d’adresse normalisée ± filtre postal) ;
- **bornée** : jusqu’à **500** candidats avec code postal, jusqu’à **2000** sans filtre postal ;
- lorsqu’un candidat correspondant est trouvé dans ce périmètre, AUTO est orienté REVIEW (`POTENTIAL_DUPLICATE`) et l’auto-convert SYSTEM peut être bloqué.

**Ce n’est pas** une preuve globale d’absence de doublon chantier dans le tenant.

### 4.3 Autres notes F10 / F4

**GAP — F10 (G-INV) :** la matrice `INV_*` **ne crash pas** le process et **n’est pas** un gate runtime des crons.
**PRECONDITION activation large :** ne pas s’appuyer sur `INV_*` comme kill-switch ; vérifier explicitement les flags et policies.

**PRECONDITION — F4 résolution partner :** si `resolvedPartnerId` absent, fallback domaine uniquement si `requireExactEmail !== true` ; sinon flags auto restent fail-closed (OFF). Réf. `auto-decision.service.ts`.

---

## 5. Inertie des crons

### 5.1 Écriture métier vs écriture technique

| Type | Exemples | Norme |
|------|----------|--------|
| **Écriture métier** | Création / transition `AcquisitionMessage`, draft, approve, convert, download métier de contenu | Interdite sur chemins SKIPPED / gate refusée |
| **Écriture technique** | `getOrCreate` curseur, `recordFailure` curseur, lease orchestrateur | Peut exister **sans** avancement `lastHistoryId` de succès et **sans** ingestion/conversion |

### 5.2 Règle normative (bornée)

Si **cron désactivé** **OU** **master OFF** **OU** **capacité requise OFF** (selon le **gate du cron** concerné) :

1. le run se termine en **SKIPPED** / `allowed: false` selon le gate ;
2. **aucune écriture métier** Acquisition (pas de nouveau draft métier, approve, convert…) via ce chemin ;
3. **aucun avancement de `lastHistoryId` de succès** ;
4. **aucune conversion** ;
5. **aucun side effect Booking** (pipelines disjoints).

Les gates **les plus amont** (ex. orchestrateur : cron OFF / master OFF avant workers) peuvent empêcher **toute** mutation y compris technique des workers.

Certains chemins **SKIPPED plus tardifs** peuvent avoir réalisé une **initialisation technique** avant le skip.

### 5.3 Exemple réel : `NO_ACTIVE_PARTNER_IDENTITIES`

Dans `acquisition-gmail-sync.service.ts` :

1. Si master OFF via `ingestion.isEnabled()` → SKIPPED **avant** `getOrCreate` (aucune écriture cursor).
2. Sinon → `cursorRepository.getOrCreate(...)` peut s’exécuter.
3. Puis, si le provider remonte `NO_ACTIVE_PARTNER_IDENTITIES` → statut **SKIPPED** avec ce `skipReason`.

Donc : **SKIPPED ≠ toujours zéro écriture**. Ici : possible écriture / init technique du cursor, **sans** avancer `lastHistoryId` de succès, **sans** ingestion métier des messages.

### 5.4 Autres écritures techniques connues

| Situation | Effet | Référence |
|-----------|-------|-----------|
| Échec chargement curseur | `recordFailure(..., "CURSOR_LOAD_FAILED")` puis `FAILED` | sync.service |
| Échec provider list (hors skip identities) | `recordFailure(..., "PROVIDER_LIST_FAILED")` puis `FAILED` | sync.service |
| Orchestrateur | lecture/écriture **lease** | lease repository / service |

Ordre des skipReasons gates (OPS-001) : `CRON_DISABLED` → `MASTER_DISABLED` → capacités (`DOWNLOAD_*`, `CONTENT_FETCH_DISABLED`, `EXTRACTION_DISABLED`, …). Auth Bearer `CRON_SECRET` **avant** les gates métier.

### 5.5 Matrice vs inertie

**GAP (G-INV) :** une config `INV_*` peut coexister tant que les services n’exécutent pas le chemin interdit. Pour les lots d’activation : **flags cohérents** + policies OFF par défaut jusqu’au GO explicite.

---

## 6. AUTO vs REVIEW

Source normative de décision pure : `evaluateAutoDecision` dans
`src/lib/acquisition/policy/auto-decision.policy.ts`.
Orchestration : `src/lib/acquisition/policy/auto-decision.service.ts`.

### 6.1 Préconditions d’AUTO (conjonction) — chemin pipeline nominal

Sur le **chemin d’entrée gated** (extraction qui a déjà passé son check master, puis auto-decision), AUTO n’est **possible** que si :

| Couche | Condition | Source / limite |
|--------|-----------|-----------------|
| Env auto | `ACQUISITION_AUTO_APPROVE_ENABLED === "true"` | Early return service si OFF |
| Partner | Partner actif résolu + `autoApproveEnabled === true` | Sinon approve effectif false → REVIEW |
| Actor | `resolveValidatedSystemActor` OK | Sinon pas d’approve (voir §6.5) |
| Draft | Statut `PENDING_REVIEW` | Sinon no-op |
| Tenant | Lectures draft/partner scopées `companyId` ; user actor doit matcher le tenant | service / system-actor |
| Données | Nom chantier, dates valides (start≤end), adresse+ville, identité client | policy |
| Confiance | clés requises ≥ `minConfidence` | policy |
| Warnings | Aucun warning `blocking: true` | policy |
| Duplicate | Aucun doublon **détecté** par l’algo courant | matching borné §4.2 |
| Client | Pas ambigu | matching + policy |
| Injection | Pas `POTENTIAL_PROMPT_INJECTION` | policy |
| Documents | Pas document requis illisible selon règles policy/service | policy + helper |

**Master :** typiquement ON sur le chemin extraction gated. **Ce n’est pas** un check interne de `maybeRunAutoDecisionAfterExtraction` (voir **G-MASTER-SERVICE-SCOPE**).

**Capability conversion** (pour tenter `AUTO_APPROVE_CONVERT` puis convert) :

- Env `ACQUISITION_AUTO_CONVERT_ENABLED === "true"`
- Partner `autoConvertEnabled === true`
- Conversion métier : `isAcquisitionConversionFullyEnabled()` = master ∩ `ACQUISITION_CONVERSION_ENABLED` (service conversion) — voir §7
- `allowCreateClient` **uniquement** si clientMode NEW (§7)

### 6.2 Codes de décision policy (`decisionCode` issus de `evaluateAutoDecision`)

| `decisionCode` | Signification |
|----------------|---------------|
| `HUMAN_REVIEW_REQUIRED` | Pas d’auto-approve policy |
| `AUTO_APPROVE_ONLY` | Seuils OK ; convert effectif OFF |
| `AUTO_APPROVE_CONVERT` | Seuils OK ; convert effectif ON |

### 6.3 Reasons policy (`reasons[]` de `evaluateAutoDecision`)

Liste exhaustive du fichier policy :

| Reason code | Déclencheur (résumé) |
|-------------|----------------------|
| `AUTO_APPROVE_DISABLED` | `autoApproveEnabled` effectif false |
| `MISSING_WORKSITE_NAME` | nom chantier vide |
| `INVALID_DATES` | dates manquantes ou start > end |
| `AMBIGUOUS_ADDRESS` | adresse/ville manquantes ou adresse &lt; 5 car. |
| `MISSING_CLIENT_IDENTITY` | ni nom ni email client |
| `AMBIGUOUS_CLIENT` | matching ambigu ou warning `CLIENT_IDENTITY_AMBIGUOUS` |
| `POTENTIAL_DUPLICATE` | doublon **détecté** en amont (algo courant) |
| `PROMPT_INJECTION_RISK` | warning `POTENTIAL_PROMPT_INJECTION` |
| `REQUIRED_DOCUMENT_UNREADABLE` | document requis illisible selon règles |
| `BLOCKING_WARNINGS` | warning `blocking: true` |
| `LOW_CONFIDENCE:worksiteName` | score &lt; min |
| `LOW_CONFIDENCE:requestedStartDate` | score &lt; min |
| `LOW_CONFIDENCE:requestedEndDate` | score &lt; min |

### 6.4 Fallback unique (policy)

La policy pure **ne crée jamais** de client/chantier. Fallback unique de décision policy : `HUMAN_REVIEW_REQUIRED`.

### 6.5 Vocabulaire service — ne pas fusionner

Couches distinctes après / autour de la policy :

| Couche | Exemples | Rôle |
|--------|----------|------|
| **`decisionCode` journal (policy)** | `HUMAN_REVIEW_REQUIRED`, `AUTO_APPROVE_ONLY`, `AUTO_APPROVE_CONVERT` | Sortie `evaluateAutoDecision` journalisée en premier append |
| **`decisionCode` journal (post-policy)** | `SYSTEM_ACTOR_INVALID` | Append **distinct** si actor non OK **après** une décision AUTO policy |
| **`reasons[]` journal** | Reasons policy ; ou `[systemActor.code, systemActor.reason]` | Tableau string du journal |
| **Codes résolution actor** | `SYSTEM_ACTOR_MISSING` (env unset), `SYSTEM_ACTOR_INVALID` (user/tenant/rôle/actif) | Retour de `resolveValidatedSystemActor` — **pas** le `decisionCode` journal quand missing |
| **Logs stdout** | `DECISION`, `SYSTEM_ACTOR_INVALID`, `AUTO_APPROVE_FAILED`, `AUTO_CONVERT_SKIPPED_NO_CLIENT`, `AUTO_CONVERT_SKIPPED_NO_CLIENT_NAME`, `AUTO_CONVERT_BLOCKED_DUPLICATE`, `AUTO_CONVERT_RESULT` | Observabilité ; **pas** des `decisionCode` policy |
| **Skip reason sync/cron** | `FEATURE_DISABLED`, `NO_ACTIVE_PARTNER_IDENTITIES`, `CRON_DISABLED`, … | Autre couche (sync / gates) |

**Clarification SYSTEM_ACTOR :**

- Si env `ACQUISITION_SYSTEM_ACTOR_USER_ID` absente : résolution → `{ ok: false, code: "SYSTEM_ACTOR_MISSING", reason: "env_unset" }`.
- Si user invalide pour le tenant : résolution → `{ ok: false, code: "SYSTEM_ACTOR_INVALID", reason: "…" }`.
- Dans les deux cas, le service journalise un append avec **`decisionCode: "SYSTEM_ACTOR_INVALID"`** et `reasons: [systemActor.code, systemActor.reason]` (donc `SYSTEM_ACTOR_MISSING` peut apparaître dans **reasons**, pas comme `decisionCode`).
- Logs : événement `SYSTEM_ACTOR_INVALID` avec champs `code` / `reason` de la résolution.

**Note PDF :** `PDF_NO_TEXT_LAYER` / `PDF_PARSE_FAILED` seuls ne poussent `REQUIRED_DOCUMENT_UNREADABLE` dans la policy que si `requiredDocumentUnreadable` ou code `REQUIRED_DOCUMENT_UNREADABLE`.

---

## 7. Conversion

Source : `conversion.service.ts` + flags + auto-decision service.

| Règle | Garantie prouvée | Limite |
|-------|------------------|--------|
| Conversion **distincte** de l’approbation | États `APPROVED` → `CONVERTED` | — |
| Décision auto-convert | Env auto-convert ∩ partner `autoConvertEnabled` | Distinct du flag conversion métier |
| Conversion métier fully | `isAcquisitionConversionFullyEnabled()` = master ∩ `ACQUISITION_CONVERSION_ENABLED` | ≠ flag brut seul ; ≠ `autoConvert` |
| `allowCreateClient` | Bloque uniquement auto **NEW** client | **N’est pas** requis pour convert **EXISTING** |
| Doublon | Bloque auto-convert si candidat **détecté** (algo courant) + check service | Pas une preuve globale d’unicité |
| Déjà converti | `ALREADY_CONVERTED` | Chemin idempotent de reprise |
| État invalide | Refus si ≠ `APPROVED` (hors already converted) | — |
| Version | Claim / `expectedVersion` transactionnel | — |

**PRECONDITION (P-CONV) activation auto-convert :**
master ON (chemin gated) **et** `ACQUISITION_CONVERSION_ENABLED` **et** auto-approve ON **et** auto-convert ON **et** partner policies cohérentes **et** system actor OK pour le tenant cible.
`allowCreateClient` **seulement** si on autorise NEW.

---

## 8. Tenant isolation

| Règle | Garantie code | Réf. |
|-------|---------------|------|
| Lectures draft auto-decision : `findFirst({ id, companyId })` | Oui | auto-decision.service |
| Partner lookup par `companyId` | Oui | PartnerRegistryRepository |
| Review / conversion portent `companyId` dans le contexte actor | Oui | review / conversion |
| Policies d’un tenant non applicables à un autre | Oui — requêtes scopées | repository / admin |
| Éligibilité multi-tenant | Tests runtime | `register-incoming-eligibility.runtime.test.ts` |

### 8.1 SYSTEM_ACTOR et tenant

- `ACQUISITION_SYSTEM_ACTOR_USER_ID` est **un** identifiant utilisateur fourni par l’**environnement** (pas une table de config « un actor par tenant » dans le code actuel).
- La protection tenant signifie : le run auto **ne passe** l’approve que si **cet** utilisateur existe, est actif, a un rôle autorisé (`ADMIN` | `SUPER_ADMIN`), et a `user.companyId === companyId` **cible** (`tenant_mismatch` sinon).
- Il n’existe **pas** nécessairement une configuration SYSTEM_ACTOR distincte par tenant dans l’env ; un même userId ne peut valider que le tenant auquel il appartient.

**GAP :** pas de linter d’imports cross-tenant global. Les lots suivants conservent des tests d’isolation sur les chemins touchés.

---

## 9. Idempotence et retries — garanties bornées

**Ne pas** affirmer une idempotence universelle des « retries cron ».
Mécanismes existants — **ne pas modifier** dans 012-0 :

| MÉCANISME | GARANTIE PROUVÉE | LIMITE |
|-----------|------------------|--------|
| Message Gmail — unicité `(companyId, source, externalMessageId)` | Pas de double création métier sur conflit ; relecture P2002 | Ne couvre pas d’autres side-effects hors ce modèle |
| Attachments — `attachmentKey` stable (+ `ext-sha256` si long) ; `externalAttachmentId` complet persisté | Clé déterministe pour createMany / unicité attachment | — |
| Review — `expectedVersion` / optimistic concurrency | Conflit → `STATE_CHANGED` ; pas de transition silencieuse sur mauvaise version | **Pas** une preuve d’idempotence forte de résultat pour **toutes** les opérations review (ex. effets annexes non couverts ici) |
| Conversion — claim/version TX ; statut `CONVERTED` | Reprise → `ALREADY_CONVERTED` ; pas de second chantier sur ce chemin claim | Borné au service conversion |
| Cursor sync — `lastHistoryId` | Non avancé sur PARTIAL / FAILED / SKIPPED ; persisté après succès complet de pagination | Écritures techniques cursor (`getOrCreate`, `recordFailure`) hors cette garantie |
| Futurs side-effects | — | **Non extrapolés** par cette SPEC |

---

## 10. Non-effet Booking

**Règle explicite (normative pour toute la série `PLAN-ACQ-012-*`) :**

Les lots `PLAN-ACQ-012-*` **ne doivent jamais** :

1. modifier `/api/cron/gmail-scan` ni `src/lib/booking/**` ;
2. changer les règles / flags / cursors Booking ;
3. partager les cursors Booking avec Acquisition ;
4. réutiliser les états Booking comme états Acquisition ;
5. créer une dépendance code **Acquisition → Booking**.

Acquisition (consultations / import drafts / registre) et Booking (gmail-scan / pending) restent **deux pipelines distincts**.

**Constat HEAD :** aucun import Booking sous `src/lib/acquisition`.
**Tests d’acceptation futurs :** non-régression Booking / gmail-scan (suite existante booking + smoke import).

---

## 11. Fencing / concurrence

### 11.1 État réel (documenté, pas à coder ici)

| Élément | État | Réf. |
|---------|------|------|
| Lease orchestrateur | **Existant** | lease repository + service |
| `assertOwned` avant chaque step | **Existant** | orchestrator.service |
| Heartbeat mid-run Gmail (`shouldContinue` + `renew`) | **Existant** | orchestrator-workers (gmail) |
| Heartbeat mid-run attachment / content / extraction | **Incomplet** | `docs/acquisition-ops-v2-fencing-workers.md` |

### 11.2 Précondition activation

**PRECONDITION — auto/convert large ou traitements longs prod :**
soit livrer le fencing mid-worker non-Gmail (ticket technique déjà nommé `PLAN-ACQ-V2-FENCING-WORKERS` dans le doc fencing),
soit prouver que chaque worker a `maxDurationMs` **strictement** sous le TTL lease avec marge (critère du même doc).

012-0 **ne code pas** cette solution ; elle la rend **bloquante** pour un GO auto/convert large (§12).

---

## 12. GO / NO-GO

### 12.1 Contrat code actuel — `readyForOrchestratorE2E`

Source : `src/lib/acquisition/ops/acquisition-staging-readiness.ts`.

`readyForOrchestratorE2E === true` seulement si **toutes** ces conditions calculées sont vraies :

- `flags.master`
- `flags.orchestratorCron`
- `leaseTablePresent`
- identité partenaire active (domaines **ou** emails)
- **`!flags.conversionFully`** (master ∩ conversion brut — **pas** le flag brut conversion seul, et **pas** `autoConvert`)
- **`!flags.autoApprove`**
- aucun `flagIssues` dont le code commence par `INV_ORCHESTRATOR`

**Le code ne teste pas** `!flags.autoConvert` pour ce booléen.

### 12.2 Recommandation ops (≠ invariant code)

Le runbook staging (`docs/acquisition-ops-v2-staging-activation.md`) recommande de garder **également** `ACQUISITION_AUTO_CONVERT_ENABLED` et conversion brut **OFF** de façon conservatrice pendant Lot C.

Ce sont des **recommandations opérationnelles**, pas des champs du calcul `readyForOrchestratorE2E`.

**P-STAGE :** avant d’interpréter `readyForOrchestratorE2E`, distinguer **A. contrat code §12.1** et **B. recommandation ops §12.2**.

### 12.3 GO minimal avant activation automatique (approve et/ou convert)

- [ ] Staging E2E vert jusqu’au niveau ciblé
- [ ] Inventaire flags connus (matrice + env)
- [ ] Partner policies **explicites** par tenant
- [ ] `ACQUISITION_SYSTEM_ACTOR_USER_ID` positionné et **valide pour le tenant cible** (§8.1)
- [ ] Readiness registre OK ; readiness staging interprétée selon §12.1 / §12.2
- [ ] `autoApprove` / `autoConvert` contrôlés (env ∩ partner) ; `allowCreateClient` seulement si NEW autorisé
- [ ] Détection duplicate **heuristique** validée (tests + scénario) — pas une preuve d’absence globale
- [ ] Mécanismes d’idempotence §9 validés sur leurs périmètres
- [ ] Fencing **suffisant** pour le niveau (§11.2)
- [ ] Rollback documenté (flags OFF + master OFF sur **entrées gated**)
- [ ] Logs / journal exploitables

### 12.4 NO-GO

Tout manquement ⇒ **NO-GO** activation auto.

---

## 13. Mapping PLAN-ACQ-012-1 à 012-7

Squelette de **gouvernance** uniquement.
Contenu produit non encore spécifié dans le dépôt ⇒ **TBD / À SPÉCIFIER**.
Ne pas traiter les TBD comme des features promises.

### PLAN-ACQ-012-1

| Champ | Contenu |
|-------|---------|
| Objectif | Gate de gouvernance : adoption de PLAN-ACQ-012-0 ; gel AUTO/REVIEW ; checklist GO/NO-GO ; aucune activation runtime. SPEC : `docs/plan-acq-012-1-auto-review-adoption.spec.md` |
| Préconditions | PLAN-ACQ-012-0 revue / acceptée |
| Dépendances | Code Lot F / registre déjà présents |
| Preuves nécessaires | Revue SPEC 012-1 ; gel AUTO/REVIEW ; checklist GO/NO-GO ; gaps classés |
| Interdictions | Pas d’activation auto/convert ; pas Booking ; pas Prisma |
| Critère de sortie | Défini dans `docs/plan-acq-012-1-auto-review-adoption.spec.md` §10 |

### PLAN-ACQ-012-2

| Champ | Contenu |
|-------|---------|
| Objectif | Encadrement d’un pilote **AUTO_APPROVE_ONLY** (convert OFF) sur un tenant explicite. Aucune activation runtime dans le lot SPEC. SPEC : `docs/plan-acq-012-2-auto-approve-pilot.spec.md` |
| Préconditions | 012-0 ; 012-1 ; system actor valide pour le tenant ; policies ; fencing suffisant pour le périmètre ; TENANT_PILOT identifié avant runtime |
| Dépendances | `auto-decision.*`, review service |
| Preuves nécessaires | Tests §14 ; journal `AUTO_APPROVE_ONLY` / `HUMAN_REVIEW_REQUIRED` ; checklist 012-2 |
| Interdictions | Auto-convert ; NEW client ; création chantier auto ; Booking ; activation runtime dans le lot SPEC |
| Critère de sortie | Défini dans `docs/plan-acq-012-2-auto-approve-pilot.spec.md` §14 (DONE SPEC ≠ pilote runtime activé) |

### PLAN-ACQ-012-3

| Champ | Contenu |
|-------|---------|
| Objectif | **TBD / À SPÉCIFIER** — candidat : activation **contrôlée auto-convert** (après 012-2) |
| Préconditions | 012-2 OK ; conversion fully ; `allowCreateClient` explicite **si NEW** ; détection duplicate validée |
| Dépendances | conversion.service ; matching |
| Preuves nécessaires | Idempotence convert (`ALREADY_CONVERTED` / version) ; auto-convert bloqué lorsqu’un doublon est **détecté** par l’algo courant |
| Interdictions | Contournement review ; Booking ; affirmer une absence globale de doublons |
| Critère de sortie | **TBD** |

### PLAN-ACQ-012-4

| Champ | Contenu |
|-------|---------|
| Objectif | **TBD / À SPÉCIFIER** — candidat : fencing mid-worker non-Gmail (`PLAN-ACQ-V2-FENCING-WORKERS`) |
| Préconditions | Doc fencing ; orchestrateur stable |
| Dépendances | orchestrator-workers / lease |
| Preuves nécessaires | Tests expiration mid-run / LEASE_STOLEN |
| Interdictions | Activer auto large sans §11.2 |
| Critère de sortie | **TBD** |

### PLAN-ACQ-012-5

| Champ | Contenu |
|-------|---------|
| Objectif | **TBD / À SPÉCIFIER** — candidat : runbook activation flags (OPS-007) |
| Préconditions | OPS-001 |
| Dépendances | Docs ops existantes |
| Preuves nécessaires | Runbook publié ; rollback flags |
| Interdictions | Secrets dans docs |
| Critère de sortie | **TBD** |

### PLAN-ACQ-012-6

| Champ | Contenu |
|-------|---------|
| Objectif | **TBD / À SPÉCIFIER** |
| Préconditions | **TBD** |
| Dépendances | **TBD** |
| Preuves nécessaires | **TBD** |
| Interdictions | Booking ; gmail-scan ; hors Acquisition sans SPEC dédiée |
| Critère de sortie | **TBD** |

### PLAN-ACQ-012-7

| Champ | Contenu |
|-------|---------|
| Objectif | **TBD / À SPÉCIFIER** |
| Préconditions | **TBD** |
| Dépendances | **TBD** |
| Preuves nécessaires | **TBD** |
| Interdictions | Booking ; gmail-scan ; hors Acquisition sans SPEC dédiée |
| Critère de sortie | **TBD** |

---

## 14. Tests d’acceptation requis pour les lots suivants

| Thème | Exigence | Ancrage existant (non exhaustif) |
|-------|----------|----------------------------------|
| AUTO decision reasons | Codes / reasons policy | `auto-decision.policy.test.ts` |
| REVIEW exhaustive | Reasons §6.3 | policy + service tests |
| Cron inert | Gates OFF → SKIPPED / no métier ; tolérer écriture technique documentée | flag-matrix ; sync / orchestrator tests |
| Tenant isolation | Pas de fuite cross-tenant | eligibility ; conversion integration |
| Idempotence bornée | Selon table §9 | acquisition / conversion / review |
| Duplicate protection | REVIEW + block convert **si détecté** | auto-decision.service ; matching |
| System actor | `decisionCode` journal `SYSTEM_ACTOR_INVALID` ; reasons peuvent contenir `SYSTEM_ACTOR_MISSING` | auto-decision.service / system-actor |
| Partner policy OFF | REVIEW malgré env ON | auto-decision.service |
| allowCreateClient OFF | Pas de NEW ; EXISTING toujours possible si autres conditions OK | auto-decision.service |
| Booking / gmail-scan | Non-régression ; pas d’import Acquisition→Booking | `tests/booking/**` |
| Fail-closed flags | `=== "true"` only | `acquisition-flag-matrix.test.ts` |
| Kill-switch | Master OFF sur **entrées gated** ; auto OFF sur service auto-decision | gates + early return |

012-0 **n’ajoute aucun test**.

---

## 15. Hors scope

- toute implémentation code / test ;
- Prisma schema / migrations ;
- Gmail parser / mapper / OAuth ;
- Booking / `gmail-scan` ;
- Vercel / Raspberry Pi / scheduler ;
- activation ou modification de flags runtime ;
- production rollout ;
- fermeture des GAP (lots ultérieurs, sans obligation dans 012-0).

---

## 16. Synthèse GAP / PRECONDITION

| ID | Type | Description |
|----|------|-------------|
| G-INV | GAP | `INV_*` détectés mais non bloquants process |
| G-FENCE | GAP / PRECONDITION | Heartbeat mid-worker non-Gmail incomplet avant auto/convert large |
| G-RB | GAP | Runbook `RB-PLAN-ACQ-001-activation-flags.md` (OPS-007) absent |
| G-MASTER-SERVICE-SCOPE | GAP | Master non enforceé dans chaque service interne (`registerIncomingMessage`, `maybeRunAutoDecisionAfterExtraction`, …) — protection via entrées gated |
| P-ACTOR | PRECONDITION | User `ACQUISITION_SYSTEM_ACTOR_USER_ID` valide **pour le tenant cible** avant AUTO (env unique, pas config multi-tenant native) |
| P-CONV | PRECONDITION | Conversion fully + policies auto-convert ; `allowCreateClient` seulement si NEW |
| P-STAGE | PRECONDITION | Interpréter `readyForOrchestratorE2E` selon **contrat code** (`!autoApprove` ∧ `!conversionFully` + autres §12.1) ; ops peut exiger en plus `autoConvert` OFF (§12.2) — ne pas confondre |

---

## Historique

| Date | Note |
|------|------|
| 2026-08-15 | Création SPEC suite audit READ-ONLY `SPEC_SCOPE_PROVEN` (HEAD `3139725`) |
| 2026-08-15 | R1 — bornage garanties (master, readiness, duplicate, idempotence, actor, cursor technique) |
