# PLAN-ACQ-012-5 — Activation Flags Runbook Governance

| Champ | Valeur |
|-------|--------|
| **Ticket** | PLAN-ACQ-012-5 |
| **Type** | SPEC normative d’encadrement d’un **futur** runbook d’activation / rollback des flags Acquisition (documentation seule) |
| **Statut** | DRAFT — prêt pour revue |
| **HEAD de référence** | `97b92f5d7d6944d29efadc7a17a811e974d1ba8a` |
| **Sources normatives** | `docs/plan-acq-012-0-auto-review-guardrails.spec.md` … `docs/plan-acq-012-4-non-gmail-worker-fencing.spec.md` |
| **Sources ops existantes** | `docs/acquisition-ops-001-flags.md` ; `docs/acquisition-ops-002-scheduling.md` ; `docs/acquisition-ops-v2-staging-activation.md` |
| **Implémentation / publication OPS-007** | **Interdite** dans ce lot |
| **Activation runtime** | **Interdite** dans ce lot |

---

## 1. Rôle

PLAN-ACQ-012-5 **définit le contrat documentaire** d’un **futur** runbook d’activation des flags Acquisition.

Cible déjà nommée (non créée) : `RB-PLAN-ACQ-001-activation-flags.md` — lot **OPS-007** (`docs/acquisition-ops-001-flags.md`).

012-5 précise :

- quelles informations le runbook **devra** contenir ;
- quelles préconditions doivent être vérifiées (012-0…012-4) ;
- dans quel **ordre documentaire** les capacités peuvent être activées ;
- comment **revenir en arrière** (contrat, non exécuté) ;
- quelles **preuves** sont requises.

Ce lot :

- **ne crée pas** OPS-007 / `RB-PLAN-ACQ-001-activation-flags.md` ;
- **ne modifie aucun** flag runtime, scheduler, Vercel, Raspberry Pi, Prisma, Booking, `gmail-scan` ;
- **ne contourne pas** **G-FENCE CLOSED** (012-0 §11.2) ni `FENCING_IMPLEMENTATION_READY` = **YES** (fencing **≠** activation AUTO) ;
- **n’affirme pas** que les pilotes runtime 012-2 / 012-3 ont eu lieu.

**012-5 SPEC DONE ≠ OPS-007 publié ≠ runtime ready ≠ production ready.**

---

## 2. Sources de vérité

| Source | Rôle | Statut |
|--------|------|--------|
| `docs/acquisition-ops-001-flags.md` | Matrice flags, convention `=== "true"`, `INV_*` = détection | **Existant** |
| `src/lib/acquisition/acquisition-flag-matrix.ts` | `getAcquisitionFlagMatrix` / `validateAcquisitionFlagMatrix` | **Existant** |
| Helpers `*-feature-flag.ts` / attachment-policy / attachment-access | Lecture env | **Existant** |
| `src/lib/acquisition/ops/acquisition-staging-readiness.ts` | `readyForOrchestratorE2E` | **Existant** |
| `docs/acquisition-ops-v2-staging-activation.md` | Runbook **staging Lot C** (PENDING_REVIEW, pas AUTO) | **Existant** — **n’est pas** OPS-007 |
| `docs/acquisition-ops-002-scheduling.md` | Routes cron, Hobby, scheduler externe **non configuré dans ce lot ops** | **Existant** |
| PLAN-ACQ-012-0 … 012-4 | Garde-fous AUTO/REVIEW, pilotes, fencing | **Normatif** |
| `RB-PLAN-ACQ-001-activation-flags.md` | Runbook flags **cible OPS-007** | **`OPS_007_STATUS: NOT_CREATED`** |

Aucune garantie plus forte que le code / les SPECs cités. Pas de fichier inventé comme existant.

---

## 3. Inventaire des flags

Convention booléenne (confirmée OPS-001 / 012-0 F1) : **uniquement** `process.env.<NAME> === "true"` (casse). Absent / autre valeur = **OFF**.

**DEFAULT_EFFECTIVE_STATE** = effet si unset. **ROLLBACK_VALUE** = valeur documentaire pour OFF (jamais une secret value).

Aucun secret, token, user id réel, URL, host DB dans ce tableau.

### 3.1 Flags booléens d’activation (matrice)

| NAME | ROLE | DEFAULT_EFFECTIVE_STATE | DEPENDENCY | MUTUAL_CONSTRAINT | RUNTIME_RISK | ROLLBACK_VALUE |
|------|------|-------------------------|------------|-------------------|--------------|----------------|
| `PLANIFICATOR_ACQUISITION_ENABLED` | Master kill-switch **d’entrée** (chemins **gated** seulement — 012-0 §4.1 / **G-MASTER-SERVICE-SCOPE**) | OFF | — | `INV_*_WITHOUT_MASTER` si capacité/cron ON sans master (**détection**, pas crash) | Ouvre les **entrées gated**. **Ne coupe pas** seul `maybeRunAutoDecisionAfterExtraction` (gate auto-approve) | unset / ≠ `"true"` |
| `ACQUISITION_GMAIL_CRON_ENABLED` | Unit cron Gmail Acquisition | OFF | Master pour un run métier (gate) | `INV_GMAIL_CRON_WITHOUT_MASTER` | Sync + cursor `lastHistoryId` **sans** `shouldContinue` orchestrateur (012-4) | unset / ≠ `"true"` |
| `ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED` | Capacité download PJ | OFF | Master (matrice) | `INV_DOWNLOAD_WITHOUT_MASTER` | I/O storage | unset / ≠ `"true"` |
| `ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED` | Unit cron download | OFF | Master + capacité download | `INV_DOWNLOAD_CRON_WITHOUT_MASTER` / `_WITHOUT_CAPABILITY` | Double drain si ∥ orchestrateur | unset / ≠ `"true"` |
| `ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED` | Unit cron recovery | OFF | Master + capacité download | `INV_RECOVERY_WITHOUT_MASTER` / `_WITHOUT_DOWNLOAD` | Reclaim / retry PJ | unset / ≠ `"true"` |
| `ACQUISITION_ATTACHMENT_ACCESS_ENABLED` | Accès PJ signé (n’ôte jamais AuthZ — OPS-001) | OFF | Master (matrice) | `INV_ACCESS_WITHOUT_MASTER` | URLs signées | unset / ≠ `"true"` |
| `ACQUISITION_CONTENT_FETCH_ENABLED` | Capacité fetch contenu | OFF | Master | `INV_CONTENT_WITHOUT_MASTER` | Contenu message | unset / ≠ `"true"` |
| `ACQUISITION_CONTENT_CRON_ENABLED` | Unit cron content | OFF | Master + content fetch | `INV_CONTENT_CRON_WITHOUT_MASTER` / `_WITHOUT_CONTENT` | Fetch Option A sans claim (012-4) | unset / ≠ `"true"` |
| `ACQUISITION_EXTRACTION_ENABLED` | Capacité extraction | OFF | Master + content fetch | `INV_EXTRACTION_WITHOUT_MASTER` / `_WITHOUT_CONTENT` | Claim `EXTRACTING` + hook AUTO si flags | unset / ≠ `"true"` |
| `ACQUISITION_EXTRACTION_CRON_ENABLED` | Unit cron extraction | OFF | Master + content + extraction | `INV_EXTRACTION_CRON_WITHOUT_*` | Extraction **sans** lease orchestrateur + AUTO potentiel | unset / ≠ `"true"` |
| `ACQUISITION_ORCHESTRATOR_CRON_ENABLED` | Cron orchestrateur V2 (5 steps in-process) | OFF | Master | `INV_ORCHESTRATOR_WITHOUT_MASTER` | Pipeline complet sous **une** lease globale (012-4) | unset / ≠ `"true"` |
| `ACQUISITION_CONVERSION_ENABLED` | Flag **brut** conversion ; participe à `conversionFully` (master ∩ brut) | OFF | Master pour que `conversionFully` soit true (`INV_CONVERSION_WITHOUT_MASTER` = détection) | `INV_CONVERSION_WITHOUT_MASTER` | Voir distinction **conversion manuelle vs AUTO-CONVERT** ci-dessous. **Ne pas** lire ce flag comme « exige une partner policy » | unset / ≠ `"true"` |
| `ACQUISITION_AUTO_APPROVE_ENABLED` | Kill-switch env auto-approve (early return service) | OFF | Master (matrice). Partner `autoApproveEnabled` **indépendant** | `INV_AUTO_APPROVE_WITHOUT_MASTER` | Approve auto post-extraction **si** policy AUTO | unset / ≠ `"true"` |
| `ACQUISITION_AUTO_CONVERT_ENABLED` | Kill-switch env auto-convert | OFF | autoApprove env + conversion brut (matrice) + `conversionFully` runtime convert + partner | `INV_AUTO_CONVERT_WITHOUT_AUTO_APPROVE` / `_WITHOUT_CONVERSION` | Convert auto — **NO-GO** 012-3 (runtime non exécuté) ; fencing **G-FENCE CLOSED** ≠ GO convert | unset / ≠ `"true"` |

**Capacité effective conversion** : `isAcquisitionConversionFullyEnabled()` = master **ET** `ACQUISITION_CONVERSION_ENABLED`. Ne pas confondre brut et fully (012-0 / OPS-001).

| Chemin | Ce dont il dépend | Ce dont il **ne** dépend pas du seul fait d’être « conversion » |
|--------|-------------------|------------------------------------------------------------------|
| **Conversion manuelle** (`convertImportDraft` / review humaine) | Règles **propres** au service de conversion (`conversionFully`, AuthZ ADMIN/SUPER_ADMIN **ou** actor SYSTEM, état `APPROVED`, claim version, etc. — 012-0 / 012-3 §5) | **Pas** de partner `autoConvertEnabled` **uniquement parce que** le convert est manuel |
| **AUTO-CONVERT** | Décision policy `AUTO_APPROVE_CONVERT` ; env `ACQUISITION_AUTO_CONVERT_ENABLED` ; partner `autoConvertEnabled` ; `conversionFully` ; actor SYSTEM ; garde-fous 012-0…012-4 (**G-FENCE CLOSED** ≠ GO convert ; **AUTO_RUNTIME_STATUS = OFF**) | — |

`ACQUISITION_CONVERSION_ENABLED` **autorise la capacité de conversion métier** lorsqu’il est combiné avec le master (`conversionFully`). Il **ne doit pas** être présenté comme exigeant une policy partenaire pour la **conversion manuelle**.

Existence d’un flag **≠** activation autorisée (§5).

### 3.1.1 Orchestrator-only boolean config (hors matrice)

**Hors** `getAcquisitionFlagMatrix()` / `AcquisitionFlagMatrix`. **Ne pas** confondre avec une capability métier ni l’inclure dans l’ordre P0–P6.

| NAME | ROLE | DEFAULT_EFFECTIVE_STATE | NOTES |
|------|------|-------------------------|-------|
| `ACQUISITION_ORCHESTRATOR_ALLOW_STUBS` | Autorise les stubs SUCCESS des steps orchestrateur (`createDefaultStubStepRunners`) ; **booléen réel** `=== "true"` | OFF (absent / autre valeur) | Utilisé par `acquisition-orchestrator.handler` / feature-flag orchestrateur **uniquement**. **Interdit** en environnement métier réel (tests/debug). Rollback : unset / ≠ `"true"` |

### 3.2 Non-booléens (config, pas « ON/OFF »)

À documenter dans OPS-007 uniquement par **NAME** + rôle. **Jamais VALUE** réelle.

| NAME | ROLE | ROLLBACK / note |
|------|------|-----------------|
| `ACQUISITION_SYSTEM_ACTOR_USER_ID` | User id SYSTEM pour auto (012-0 §8 / **P-ACTOR**) | Unset ⇒ pas d’auto-approve/convert (`SYSTEM_ACTOR_MISSING`). Placeholder runbook : `<SYSTEM_ACTOR_USER_ID>` |
| `ACQUISITION_AUTO_MIN_CONFIDENCE` | Seuil policy ; défaut code `0.75` | Ne pas inventer un seuil « plus sûr » dans OPS-007 sans 012-0 |
| `ACQUISITION_EXTRACTION_PROVIDER` | `deterministic` \| `anthropic` (défaut `deterministic`) | Hors activation flags booléens |
| Bornes cron / lease (`*_MAX_DURATION_MS`, `*_MAX_PER_*`, `ACQUISITION_ORCHESTRATOR_LEASE_TTL_MS`, …) | Budgets | Conservent les defaults code si unset ; **pas** une activation métier |

Autres env hors matrice (ex. `CRON_SECRET`, `DATABASE_URL`) : le runbook **peut citer le NAME** pour PRECHECK auth/DB. **Jamais la VALUE.**

### 3.3 Policies partenaire (hors env)

Source : modèle `AcquisitionPartner` — `autoApproveEnabled`, `autoConvertEnabled`, `allowCreateClient` `@default(false)` (012-0).

Les flags globaux **ne suffisent pas**. OPS-007 devra exiger l’état **explicite** de ces colonnes pour le tenant cible — **sans** les modifier dans 012-5.

---

## 4. Master / capacités

Règles **déjà validées** (012-0) — **non élargies** :

| Règle | Statut |
|-------|--------|
| Booléen runtime seulement si `=== "true"` | **F1** |
| Master = kill-switch **borné aux chemins réellement gated** | **F2** / **G-MASTER-SERVICE-SCOPE** |
| Capacité effective = intersections **réelles** (gates + `conversionFully` + env ∩ partner AUTO) | Code |
| `INV_*` = **détection**, **pas** enforcement / pas de crash process | **F10** / **G-INV** |
| Un service interne (`registerIncomingMessage`, auto-decision) **n’est pas** forcément couvert par le master | **G-MASTER-SERVICE-SCOPE** |

Le futur runbook **ne doit pas** présenter `INV_*` comme kill-switch. Un PRECHECK peut **lister** `flagIssues` ; un NO-GO ops est une **décision humaine**, pas un blocage code.

Rollback master **seul** **n’arrête pas** l’AUTO si `ACQUISITION_AUTO_APPROVE_ENABLED` reste ON **et** que le core extraction est appelé (UI / worker déjà gated autrement). OPS-007 **doit** couper l’auto-approve **explicitement** (§15).

---

## 5. Ordre d’activation

Ordre **documentaire** dérivé des **gates cron** (OPS-001 : cron → master → capacité) et des `INV_*` (détection). **Pas** un ordonnancement inventé.

Un flag **n’est pas** « activable » du seul fait qu’il existe. Chaque palier exige les préconditions 012-0…012-4 du **mode** visé.

| Palier | Intent | Flags / conditions | PRECONDITION 012-* | Autorisé par **cette** SPEC 012-5 ? |
|--------|--------|--------------------|--------------------|-------------------------------------|
| **P0** | Identité ops | Tenant `companyId` explicite ; env **staging** vs **prod** distingués ; aucun secret dans le runbook | Périmètre tenant | Structure seulement ; prod = **TBD / HORS SCOPE** §17 |
| **P1** | Identités partenaire | Readiness registre (domaine **ou** email actif) | F3 ; cutover | Documenter ; **pas** exécuter bootstrap ici |
| **P2** | Master | `PLANIFICATOR_ACQUISITION_ENABLED` | Chemins gated | Futur OPS-007 seulement |
| **P3** | Capacités worker | content → extraction ; download → (cron download / recovery / access) | Matrice | Futur OPS-007. Conversion **brut** reste **OFF** jusqu’à preuves 012-3 |
| **P4** | Pipeline jusqu’à `PENDING_REVIEW` | **Préférer** orchestrateur V2 (`ACQUISITION_ORCHESTRATOR_CRON_ENABLED`) plutôt que 5 unit crons en parallèle (`acquisition-ops-v2-staging-activation.md`) | OPS-001/002 ; 012-4 unit crons **GAP** si ∥ | Contrat documentaire = **Lot C staging** déjà décrit ; 012-5 ne l’exécute pas |
| **P5** | AUTO_APPROVE_ONLY | Env autoApprove + partner `autoApproveEnabled` + actor | **012-2** | **NO-GO dans 012-5**. Futur OPS-007 **interdit** tant que preuves 012-2 runtime **absentes** |
| **P6** | Conversion fully / AUTO_CONVERT | conversion brut + fully + autoConvert + partner + `allowCreateClient` si NEW | **012-3** + **012-4 fencing** | **NO-GO**. **G-FENCE CLOSED** ; `FENCING_IMPLEMENTATION_READY` = **YES**. Convert reste **NO-GO** : 012-3 runtime non exécuté |

`ACQUISITION_ORCHESTRATOR_ALLOW_STUBS` : **hors matrice** (§3.1.1) ; **jamais** dans un ordre d’activation métier (tests/debug uniquement).

Partner policies : **pas** un palier « après les flags » qui les remplacerait — **condition parallèle** (§9).

Readiness staging `readyForOrchestratorE2E` : **contrat code** §11 — exige notamment **`!autoApprove`** et **`!conversionFully`**. Un palier P5 **casse** ce booléen **par conception**. OPS-007 devra cesser d’utiliser ce booléen comme GO AUTO.

---

## 6. AUTO_APPROVE

Réf. **PLAN-ACQ-012-2**. Mode cible éventuel : `AUTO_APPROVE_ONLY` (convert **OFF**).

Pilote **runtime 012-2 : non exécuté** (012-2 DONE SPEC ≠ pilote runtime). 012-5 **n’écrit pas** le contraire.

Activation future `ACQUISITION_AUTO_APPROVE_ENABLED === "true"` **exige** (préconditions 012-2, non relâchées) :

- tenant identifié ;
- `SYSTEM_ACTOR` valide **pour ce tenant** ;
- partner `autoApproveEnabled` ON **pour ce partenaire** ; `autoConvertEnabled` OFF ;
- env autoConvert OFF ; conversion fully **OFF** (012-2) ;
- journal `HUMAN_REVIEW_REQUIRED` / `AUTO_APPROVE_ONLY` comme preuves ;
- fencing **suffisant pour le périmètre** (012-0 §11.2 **SATISFAITE** / **G-FENCE CLOSED** — **≠** GO AUTO ; reste TENANT / P-ACTOR / pilote 012-2) ;
- **pas** NEW client ; **pas** création chantier auto.

**012-5 ne publie pas d’autorisation d’activer autoApprove.** OPS-007 futur : section AUTO_APPROVE = **PRECONDITION / NO-GO** tant que ces preuves n’existent pas.

---

## 7. AUTO_CONVERT

Réf. **PLAN-ACQ-012-3**.

**AUTO-CONVERT = NO-GO** tant que ses préconditions ne sont pas **prouvées**.

En particulier (inchangé) :

| ID | Statut pour tout runbook / activation visée par 012-5 |
|----|--------------------------------------------------------|
| **G-FENCE** | **CLOSED** (012-0 §11.2 — frontière item/draft orchestrée ; Gmail `PAGE_BOUNDARY_PARTIAL`) |
| **`FENCING_IMPLEMENTATION_READY`** | **YES** (PR #53) — **≠** AUTO ON |
| Pilote runtime 012-2 | **Non exécuté** — PRECONDITION 012-3 |
| **`AUTO_RUNTIME_STATUS`** | **OFF** |
| **`OPS_007_STATUS`** | **NOT_CREATED** |
| **`OPS_007_READY`** | **NO** |
| **G-RB** | **OPEN** |

012-5 **ne contourne pas** ce blocage **d’activation**. Un OPS-007 qui dirait « mettre autoConvert ON » **sans** 012-3 runtime **viole** cette SPEC. Fencing READY **n’autorise pas** P6.

`INV_AUTO_CONVERT_WITHOUT_*` **détecte** des combos incohérentes ; **n’empêche pas** le process de démarrer (**G-INV**).

---

## 8. Fencing

Réf. **PLAN-ACQ-012-4**.

| Affirmation | Statut |
|-------------|--------|
| SPEC 012-4 approuvée / présente | Lot SPEC historique ≠ code. **Code** = PR #53 |
| `GMAIL_CURRENT_FENCING` | `PAGE_BOUNDARY_PARTIAL` seulement (**pas** FULLY_FENCED) |
| Mid-worker non-Gmail orchestré | **EXISTING** frontière item/draft |
| UI | **UI_GAP CLOSED** (`UI_MANUAL`, AUTO interdit ; **pas** de lease UI) |
| Unit crons | **PRECONDITION_ONLY** — **pas UNIT_CRON FENCED** |
| `FENCING_IMPLEMENTATION_READY` | **YES** |
| `G-FENCE` | **CLOSED** (sens §11.2 uniquement) |
| `AUTO_RUNTIME_STATUS` | **OFF** |

`FENCING_IMPLEMENTATION_READY` = **YES** **n’autorise pas** un AUTO large. Le futur runbook **reste** NO-GO AUTO tant que 012-2/012-3 **runtime**, tenant, P-ACTOR, flags explicites ne sont pas prouvés. UI / unit cron **ne doivent pas** réintroduire AUTO.

Un palier Lot C jusqu’à `PENDING_REVIEW` avec autoApprove **OFF** n’est **pas** un GO AUTO. Il reste soumis aux docs staging existantes — **hors publication OPS-007 dans 012-5**.

---

## 9. Partner policies

Flags globaux **insuffisants**.

| Flag / colonne partenaire | Règle existante |
|---------------------------|-----------------|
| `autoApproveEnabled` | OFF ⇒ policy `HUMAN_REVIEW_REQUIRED` + `AUTO_APPROVE_DISABLED` (si le service tourne) |
| `autoConvertEnabled` | Requis en plus de l’env pour `AUTO_APPROVE_CONVERT` |
| `allowCreateClient` | **NEW only** (012-0 F7) ; défaut `false` |

012-5 **ne modifie aucune** policy. OPS-007 devra **lire** l’état tenant/partenaire (admin service / DB) avant tout palier P5/P6.

---

## 10. SYSTEM_ACTOR / tenant

Règles **exactes** 012-0 / `system-actor.ts` :

- **un** `ACQUISITION_SYSTEM_ACTOR_USER_ID` d’environnement (pas de config multi-tenant native) ;
- validation **dans le tenant cible** (`companyId`, rôle ADMIN/SUPER_ADMIN, `active`) ;
- mismatch tenant ⇒ `SYSTEM_ACTOR_INVALID` / `tenant_mismatch` ;
- actor invalide / missing ⇒ **aucun** approve / convert automatique via le service auto-decision ; journal `decisionCode: "SYSTEM_ACTOR_INVALID"` possible.

OPS-007 : placeholder `<SYSTEM_ACTOR_USER_ID>` uniquement. **P-ACTOR** reste PRECONDITION.

---

## 11. Readiness

### 11.1 CONTRAT CODE ACTUEL — `readyForOrchestratorE2E`

Source : `acquisition-staging-readiness.ts`. **True** ssi :

- `flags.master`
- `flags.orchestratorCron`
- `leaseTablePresent`
- identité partenaire (domaines **ou** emails)
- **`!flags.conversionFully`**
- **`!flags.autoApprove`**
- aucun `flagIssues` `INV_ORCHESTRATOR*`

**Le code ne teste pas** `!flags.autoConvert`.

### 11.2 RECOMMANDATION OPS (≠ invariant code)

`docs/acquisition-ops-v2-staging-activation.md` : garder **aussi** `ACQUISITION_AUTO_CONVERT_ENABLED` et conversion brut **OFF** pendant Lot C.

**P-STAGE** : ne pas confondre A (contrat code) et B (recommandation ops).

Un OPS-007 **plus conservateur** (`!autoConvert` requis) doit être étiqueté **recommandation OPS**, pas « le code refuse autoConvert ».

---

## 12. Secrets

**RÈGLE NORMATIVE :**

Aucun secret, token, `CRON_SECRET` **value**, client secret, refresh token, `DATABASE_URL` complète, mot de passe, cookie, ni credential **ne doit** apparaître dans OPS-007 ni dans 012-5.

Autorisé : **VARIABLE_NAME** ; placeholders `<CRON_SECRET>`, `<DATABASE_HOST_STAGING>`.

Interdit : coller des values « d’exemple réalistes ».

Scan documentaire (voir §18) **obligatoire** avant publication OPS-007.

Auth cron : Bearer `CRON_SECRET` **avant** les gates (OPS-001) — le runbook décrit le **mécanisme**, pas la valeur.

---

## 13. Procédure d’activation future

Structure **obligatoire** de chaque étape du futur `RB-PLAN-ACQ-001-activation-flags.md`.

**Aucune** commande destructive, aucun `export` de secret, aucun appel runtime **dans cette SPEC 012-5**.

Patron :

| Champ | Contenu exigé |
|-------|----------------|
| **ID** | Palier P0…P6 + identifiant d’étape |
| **PRECHECK** | Tenant ; env staging vs prod ; flags **effectifs** (`=== "true"`) ; policies ; actor ; readiness **A vs B** ; G-FENCE / fencing ready si palier AUTO ; backup si migrate (hors 012-5) |
| **CHANGE** | NAME du flag + cible ON/OFF. **Pas** de VALUE secrète |
| **EXPECTED_RESULT** | Gate SKIPPED vs run métier ; `decisionCode` attendu ; **pas** d’AUTO si palier avant P5 |
| **VALIDATION** | Logs préfixe `[acquisition-*]` ; journal ; snapshot ops ; **pas** d’effet Booking |
| **STOP_CONDITION** | §14 — arrêt immédiat |
| **ROLLBACK** | §15 — dérivé de l’étape |

Etapes **minimales** à prévoir dans OPS-007 (squelette, non exécutées ici) :

1. Freeze périmètre (tenant, staging).
2. Vérifier identités partenaire.
3. Master selon palier.
4. Capacités selon graphe content/download/extraction.
5. Orchestrateur **ou** unit crons — **pas** les deux en parallèle sur le même tenant (ops V2).
6. Stop **avant** autoApprove / autoConvert tant que PRECONDITION.

Scheduler : OPS-002 — Acquisition **hors** `vercel.json` ; scheduler externe **non configuré dans ce lot ops**. OPS-007 **ne doit pas** faire croire que 012-5 active Raspberry Pi / Vercel Cron.

---

## 14. STOP CONDITIONS

Arrêt immédiat / **NO-GO** d’une étape du futur runbook si :

| Condition | Note |
|-----------|------|
| Tenant pilote non identifié | **P-*** 012-2/012-3 |
| Actor non valide pour le tenant | **P-ACTOR** |
| Policies partenaire non lues / non prouvées | §9 |
| Readiness **A** KO **pour le palier qui s’en sert** | Ne pas exiger `readyForOrchestratorE2E` après autoApprove ON |
| `AUTO_APPROVE_CONVERT` **inattendu** (journal / policy) | 012-2 |
| Conversion fully **ON** alors qu’interdite pour le palier | Lot C / 012-2 |
| Auto large / auto-convert alors que 012-2/012-3 **runtime** non prouvés | 012-2/012-3. **G-FENCE CLOSED** ≠ GO AUTO |
| Palier P5 large ou P6 alors que `AUTO_RUNTIME_STATUS = OFF` / OPS-007 absent | 012-4 READY **≠** P5/P6 |
| Logs / journal insuffisants | 012-0 §12.3 |
| Impact Booking / `gmail-scan` | Isolation |
| `INV_*` **critique détecté** | **Signal ops** à investiguer ; **pas** un crash auto. **G-INV** : ne **pas** prétendre que `INV_*` bloque le process |
| Projet / DB **production** alors que le run vise staging | ops V2 |
| Unit crons **et** orchestrateur ON ensemble | PRECONDITION ops 012-4 |
| `ACQUISITION_ORCHESTRATOR_ALLOW_STUBS` ON en staging métier | Risque faux SUCCESS |

---

## 15. Rollback flags

Contrat **documentaire**. **Non exécuté** par 012-5.

Ordre de **réduction** (inverse des risques AUTO, dérivé des gates / G-MASTER-SERVICE-SCOPE) :

1. `ACQUISITION_AUTO_CONVERT_ENABLED` → OFF (si jamais ON).
2. `ACQUISITION_AUTO_APPROVE_ENABLED` → OFF (**obligatoire** pour stopper le hook ; master **insuffisant** seul sur ce service).
3. `ACQUISITION_CONVERSION_ENABLED` → OFF si le palier l’exige (casse `conversionFully`).
4. Crons : orchestrateur et/ou unit crons → OFF.
5. Capacités worker → OFF si besoin d’arrêter UI extraction / download.
6. `PLANIFICATOR_ACQUISITION_ENABLED` → OFF = kill-switch **uniquement** sur **entrées gated** (012-0 F2).

Toujours :

- **conserver les journaux** (`acquisition_decision_journals`) ;
- **ne pas** supprimer les drafts / messages / PJ déjà créés ;
- **aucune** « déconversion » (`CONVERTED` → …) ;
- **aucun** rollback Booking / cursor Booking / `gmail-scan` ;
- leave lease : expirer TTL ou release **même** `ownerRunId` (012-4) — pas d’inventer un outil.

Ops V2 existant (§7 staging) : orchestrateur OFF puis master — **complété** ici par la coupure auto-approve **explicite** pour tout palier qui l’aurait armé.

---

## 16. Vérification post-changement future

Le futur runbook **exigera** (non obtenues ici) :

- flags **effectifs** (`getAcquisitionFlagMatrix` / snapshot) ;
- logs `[acquisition-orchestrator]` / workers ;
- journal `decisionCode` (REVIEW vs AUTO) ;
- absence d’erreurs critiques inattendues ;
- **absence d’effet Booking** ;
- aucun AUTO **non** attendu pour le palier ;
- cursor / worker cohérents **si** palier sync (Gmail `lastHistoryId` — 012-4 partiel).

**Ne pas** prétendre ces preuves déjà obtenues.

---

## 17. Environnements

| Env | Contrat 012-5 |
|-----|----------------|
| **Staging** | Réf. unique d’activation pipeline **jusqu’à REVIEW** : `docs/acquisition-ops-v2-staging-activation.md`. OPS-007 **s’y aligne** pour P0–P4 ; **n’active pas** AUTO. |
| **Production** | **TBD / HORS SCOPE**. Aucune procédure production inventée. Pas de rollout Vercel Production / Pi prod. |

**NO-GO** si confusion staging/prod (ops V2).

Scheduling Acquisition : externe, **non** `vercel.json` (Hobby). Présence des routes ≠ activation. `/api/cron/gmail-scan` **Booking** inchangé.

---

## 18. Tests / validation documentaire

**Pas de tests code** dans 012-5. Scénarios à **valider avant publication** OPS-007.

Légende : SETUP / EXPECTED / FORBIDDEN / EVIDENCE (preuves **futures**).

| ID | SETUP | EXPECTED | FORBIDDEN | EVIDENCE |
|----|-------|----------|-----------|----------|
| T-MASTER-OFF | Master unset | Entrées **gated** SKIPPED / DISABLED selon chemin | Présenter ça comme coupe universelle AUTO | Helpers + gate |
| T-CAP-OFF | Capacité OFF (ex. content) | Cron content/extraction skip `CONTENT_FETCH_DISABLED` / `EXTRACTION_DISABLED` | Run métier | skipReason |
| T-AA-OFF | `ACQUISITION_AUTO_APPROVE_ENABLED` OFF | Early return auto-decision ; pas d’approve via ce hook | Journal AUTO | service |
| T-AC-OFF | autoConvert OFF | Pas `AUTO_APPROVE_CONVERT` effectif | Convert auto | policy ∩ flags |
| T-CF-OFF | conversion brut OFF | `conversionFully` false | Convert métier `CONVERSION_DISABLED` | conversion-feature-flag |
| T-POL-OFF | Partner autoApprove OFF, env ON | REVIEW `AUTO_APPROVE_DISABLED` (si hook tourne) | Approve | policy |
| T-ACTOR | Actor unset / mauvais tenant | Pas d’approve/convert auto | Ignore **P-ACTOR** | `SYSTEM_ACTOR_*` |
| T-TENANT | companyId mismatch actor | `tenant_mismatch` | Cross-tenant | system-actor |
| T-READY | Calcul §11.1 | Distinguer A vs rec. `!autoConvert` | Confondre avec GO AUTO | readiness.ts |
| T-RB | Appliquer §15 documentaire | autoApprove OFF avant de s’appuyer sur master | « Déconvertir » ; toucher Booking | check-list |
| T-SEC | Grep runbook | Aucune VALUE secrète | Coller `CRON_SECRET=...` | revue humaine |
| T-BOOK | Suites Booking | Non-régression | Import Acquisition→Booking | `tests/booking/**` |
| T-FENCE | Palier AUTO large / convert | **NO-GO** runtime (012-2/012-3 non exécutés ; `AUTO_RUNTIME_STATUS = OFF`). G-FENCE **CLOSED** / READY **YES** ≠ GO P5/P6 | OPS-007 qui active P5 large ou P6 sans preuves runtime | 012-4 §16.2 ; 012-2 ; 012-3 |

---

## 19. GO / NO-GO

Légende : **GO** / **PRECONDITION** / **GAP** / **NO-GO** / **TBD**.

Trois niveaux **non équivalents** :

| Niveau | Sens |
|--------|------|
| **RUNBOOK_SPEC_READY** | Cette SPEC 012-5 adoptée (contrat) |
| **RUNBOOK_READY** / **OPS_007_READY** | `RB-PLAN-ACQ-001-activation-flags.md` **publié**, sans secret, conforme 012-5 |
| **RUNTIME_READY** | Une activation **réelle** autorisée pour un palier nommé |

| ITEM | STATUS | EVIDENCE | BLOCKS_RUNBOOK_PUBLICATION | BLOCKS_RUNTIME_ACTIVATION |
|------|--------|----------|----------------------------|---------------------------|
| Objectif 012-5 figé | **GO** (ce doc) | §1 / §20 | YES si flou | YES |
| Inventaire flags | **GO** (documentaire) | §3 / OPS-001 / matrix | YES si flag inventé | YES |
| `OPS_007_STATUS` | **GAP** `NOT_CREATED` | grep `RB-PLAN-ACQ-001` | **YES** pour OPS_007_READY | **YES** via G-RB |
| Ordre P0–P6 | **GO** documentaire | §5 | YES si palier AUTO sans PRECONDITION | P5/P6 **YES** |
| AUTO_APPROVE runtime | **PRECONDITION** / **NO-GO** 012-5 | 012-2 ; pas de pilote exécuté | NO pour SPEC DONE | **YES** |
| AUTO_CONVERT | **NO-GO** | 012-3 | YES si OPS-007 l’autorise tôt | **YES** |
| **G-FENCE** | **CLOSED** | 012-4 / PR #53 | YES si runbook ignore les **limites** (Gmail partiel, unit crons, intra-item) **ou** active AUTO comme si fencing = GO flags | **YES** AUTO sans 012-2/012-3 runtime |
| `FENCING_IMPLEMENTATION_READY` | **YES** | 012-4 §16.2 | YES si prétendu = AUTO ON | **YES** si P5/P6 sans autres preuves |
| G-INV | **GAP** | matrice détection | NO (décrire) | **YES** si on s’y fie comme kill-switch |
| G-MASTER-SERVICE-SCOPE | **GAP** | 012-0 §4.1 | YES si rollback = master seul pour couper AUTO | **YES** mal rollbacké |
| G-RB | **GAP** | OPS-007 absent | **YES** publication | **YES** activation ops documentée |
| P-ACTOR / tenant | **PRECONDITION** | system-actor | YES si omis du runbook | **YES** AUTO |
| Readiness A vs B | **GO** distinction | §11 | YES si fusionnés | YES si mal lu |
| No-secrets | **GO** règle | §12 | **YES** si secret | **YES** |
| Staging Lot C doc | **GO** réf. existante | ops-v2-staging | NO | Palier P4 : ops existant **hors** 012-5 |
| Production | **TBD** / HORS SCOPE | §17 | NO pour SPEC | **YES** (non défini) |
| Booking isolation | **GO** | 012-0 §10 | **YES** si violation | **YES** |
| Activation dans le lot 012-5 | **NO-GO** | §1 | **YES** si effectuée | **YES** |
| `OPS_007_READY` | **NO** | fichier absent | — | — |
| `RUNTIME_READY` | **NO** | aucun palier armé ici | — | — |

Ne **pas** marquer GO l’activation AUTO ni OPS-007 publié. **Fencing livré** (`FENCING_IMPLEMENTATION_READY = YES`) **≠** GO AUTO.

---

## 20. Critère de sortie

### 20.1 PLAN-ACQ-012-5 SPEC DONE

lorsque **tous** les points suivants sont vrais :

- objectif normatif figé (§1) ;
- inventaire **réel** des flags documenté (§3) — aucun flag inventé ;
- ordre d’activation contractuel défini (§5) ;
- stop conditions définies (§14) ;
- rollback contract défini (§15) ;
- règle no-secrets figée (§12) ;
- structure du **futur** OPS-007 définie (§13) ;
- tests **documentaires** définis (§18) ;
- GO/NO-GO complet (§19) ;
- **aucun** flag runtime modifié ;
- **aucun** secret ajouté ;
- **aucun** code / test modifié.

**012-5 SPEC DONE ≠ OPS-007 publié ≠ runtime ready ≠ production ready.**

### 20.2 OPS_007_READY (ultérieur)

Condition **séparée**, **NO** aujourd’hui.

Minimum :

1. Fichier `docs/RB-PLAN-ACQ-001-activation-flags.md` (ou chemin **exact** figé OPS-001) **existe**.
2. Conforme §§12–16 de **cette** SPEC (placeholders only).
3. Palier AUTO **absent** ou **NO-GO explicite** tant que 012-2 runtime / 012-3 runtime ne sont pas **prouvés** (`FENCING_IMPLEMENTATION_READY` **déjà YES** ; **≠** `OPS_007_READY`).
4. Scan secrets **PASS**.
5. Booking / `gmail-scan` non concernés.
6. Re-audit **G-RB**.

**Statut actuel : `OPS_007_READY` = NO.**

---

## 21. Hors scope

- création effective OPS-007 / `RB-PLAN-ACQ-001-activation-flags.md`
- activation flags runtime ; Vercel env ; Raspberry Pi ; scheduler
- code ; tests code ; Prisma ; migrations
- Booking ; `/api/cron/gmail-scan`
- secrets ; production rollout
- implémentation fencing **012-4**
- PLAN-ACQ-012-6+

---

## 22. Mapping 012-0

Ce lot met à jour `docs/plan-acq-012-0-auto-review-guardrails.spec.md` :

- **mapping fonctionnel** modifier **uniquement** **PLAN-ACQ-012-5** ;
- **PLAN-ACQ-012-6** et **012-7 inchangés** (TBD) ;
- une **entrée d’historique documentaire** 012-0 peut être ajoutée ;
- **G-RB** ligne §16 de 012-0 : **inchangée** (GAP « runbook absent » ; 012-5 SPEC ≠ runbook publié).
- **G-FENCE** : désormais **CLOSED** (aligné 012-0 post-PR #53) — **sans** clore G-RB.

---

---

## Historique

| Date | Note |
|------|------|
| 2026-08-16 | Création SPEC 012-5 (DOC ONLY) HEAD `97b92f5` ; OPS-007 NOT_CREATED ; G-FENCE OPEN (état alors) ; fencing READY = NO (état alors) |
| 2026-08-17 | Alignement post-PR #53 : **G-FENCE CLOSED** ; `FENCING_IMPLEMENTATION_READY = YES` ; **OPS_007_STATUS = NOT_CREATED** ; **OPS_007_READY = NO** ; **G-RB OPEN** ; **AUTO_RUNTIME_STATUS = OFF** |
