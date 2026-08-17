# RB-PLAN-ACQ-001 — Activation Flags Runbook (OPS-007)

| Champ | Valeur |
|-------|--------|
| **ID** | `RB-PLAN-ACQ-001` |
| **Lot** | **OPS-007** |
| **Titre** | Activation Flags Runbook |
| **Scope** | **Planificator Acquisition uniquement** |
| **État** | Runbook **publié** / procédure **disponible** |
| **HEAD de référence** | `61f04e6f8e531edf78f95cbceb6fe82e2d1dc464` |
| **OPS_007_STATUS** | **CREATED** |
| **OPS_007_READY** (activation AUTO réelle) | **NO** |
| **OPS_007_READY_FOR_AUTO** | **NO** |
| **RUNBOOK_READY_FOR_P0_P4** | **YES** (procédure Lot C jusqu’à `PENDING_REVIEW`) |
| **AUTO_RUNTIME_STATUS** | **OFF** |
| **P5_STATUS** | **NO-GO** |
| **P6_STATUS** | **NO-GO** |
| **Production** | **TBD / HORS SCOPE** |

Ce fichier **ne déploie rien**, **n’active rien**, **ne choisit aucun tenant**, **ne renseigne aucun actor réel**. Il décrit comment un opérateur pourra plus tard activer **P0–P4** de façon contrôlée, et pourquoi **P5 / P6 restent STOP**.

---

## 0. Interdictions

Ce runbook **interdit** :

- toute activation AUTO **implicite** (aucune commande P5/P6 qui pose un flag AUTO à `"true"`) ;
- tout secret, token, VALUE `CRON_SECRET`, `DATABASE_URL` complète, cookie, credential ;
- tout `companyId` / tenant réel dans git (placeholder `<TENANT_COMPANY_ID>` uniquement) ;
- tout `userId` / actor réel (placeholder `<SYSTEM_ACTOR_USER_ID>` uniquement) ;
- tout changement Booking / `/api/cron/gmail-scan` ;
- tout changement Gmail (fencing, cursor, OAuth) — la sync Acquisition via orchestrateur est **documentée**, pas reconfigurée ici ;
- toute modification du scheduler, de `vercel.json`, de Prisma, des migrations, du runtime env ;
- toute définition de PLAN-ACQ-012-6 / 012-7 ;
- de transformer `INV_*` en crash-gate / kill-switch process ;
- d’élargir **G-MASTER-SERVICE-SCOPE** ;
- de modifier le calcul code `readyForOrchestratorE2E` ;
- de présenter `readyForOrchestratorE2E === true` comme **GO AUTO**.

**G-RB (sens « runbook publié »)** : **CLOSED** par l’existence de ce fichier.

**G-RB n’autorise pas** AUTO, production, ni P5/P6.

Restent **ouverts / non clos par OPS-007** : **G-INV**, **G-MASTER-SERVICE-SCOPE**, **P-ACTOR**, **P-CONV**, preuve runtime **P-STAGE** (booléen A vs palier réel).

---

## 1. Sources

| Source | Rôle |
|--------|------|
| `docs/plan-acq-012-5-activation-flags-runbook.spec.md` | Contrat OPS-007 |
| `docs/acquisition-ops-001-flags.md` | Matrice flags, `=== "true"`, gates cron, `INV_*` |
| `docs/acquisition-ops-v2-staging-activation.md` | Pipeline staging **Lot C** jusqu’à `PENDING_REVIEW` (**n’est pas** ce runbook) |
| `docs/acquisition-ops-002-scheduling.md` | Routes HTTP, Hobby, scheduler externe **non configuré** |
| `docs/plan-acq-012-0-auto-review-guardrails.spec.md` | Garde-fous AUTO / REVIEW |
| `docs/plan-acq-012-2-auto-approve-pilot.spec.md` | Contrat P5 `AUTO_APPROVE_ONLY` — runtime **non exécuté** |
| `docs/plan-acq-012-3-auto-convert-controlled.spec.md` | Contrat P6 `AUTO_APPROVE_CONVERT` — runtime **non exécuté** |
| `src/lib/acquisition/acquisition-flag-matrix.ts` | `getAcquisitionFlagMatrix` / `validateAcquisitionFlagMatrix` |
| `src/lib/acquisition/ops/acquisition-staging-readiness.ts` | **CODE CONTRACT A** `readyForOrchestratorE2E` |
| `src/lib/acquisition/policy/system-actor.ts` | Preuve actor |
| `src/lib/acquisition/policy/auto-decision.service.ts` | Hook AUTO — **pas** de check master interne |
| `src/lib/acquisition/policy/auto-decision-feature-flag.ts` | `=== "true"` AUTO + actor NAME |

Aucune garantie plus forte que ces sources. Existence d’un flag **≠** autorisation d’activation.

---

## 2. Principes

1. **Tous les booléens sont ON uniquement si** `process.env.<NAME> === "true"` (casse exacte). Absent / `"True"` / `"1"` / `"false"` / autre = **OFF**.
2. **`INV_*` = diagnostic** (`validateAcquisitionFlagMatrix`). **Pas** un kill-switch. Un PRECHECK peut **lister** `flagIssues` ; un NO-GO est une **décision humaine**.
3. **Master = gate borné** (**G-MASTER-SERVICE-SCOPE**). Il ouvre/ferme les **entrées gated**. Il **n’est pas** un rollback AUTO suffisant : `maybeRunAutoDecisionAfterExtraction` early-return uniquement si `ACQUISITION_AUTO_APPROVE_ENABLED !== "true"`.
4. **Rollback AUTO** = couper **explicitement** `ACQUISITION_AUTO_CONVERT_ENABLED` **puis** `ACQUISITION_AUTO_APPROVE_ENABLED` (§15). **Jamais master OFF seul.**
5. **`readyForOrchestratorE2E === true` = GO pipeline Lot C jusqu’à `PENDING_REVIEW`. JAMAIS GO AUTO.**
6. Flags globaux **insuffisants** pour AUTO : policies partenaire `autoApproveEnabled` / `autoConvertEnabled` / `allowCreateClient` (défaut `false`) sont une **condition parallèle**.
7. **Un seul** `ACQUISITION_SYSTEM_ACTOR_USER_ID` d’environnement — pas de config multi-tenant native.
8. Conversion **brute** (`ACQUISITION_CONVERSION_ENABLED`) ≠ `conversionFully` (= master ∩ brut). Conversion **manuelle** ≠ AUTO-CONVERT.
9. Stubs orchestrateur : `ACQUISITION_ORCHESTRATOR_ALLOW_STUBS` **OFF métier** (tests/debug only).
10. **AUTO_RUNTIME_STATUS = OFF.** Fencing **G-FENCE CLOSED** / `FENCING_IMPLEMENTATION_READY = YES` **≠** GO P5/P6.

---

## 3. P0 — Environment identity

| Champ | Contenu |
|-------|---------|
| **ID** | P0 |
| **STATUS** | Procédure **GO** / runtime **PRECONDITION** locale. Production = **TBD / HORS SCOPE** |
| **CHANGE** | **Aucun flag.** |

### PRECHECK

Noter **hors git** (dashboard / secrets manager) — **ne jamais coller de values** ici :

| Élément | Placeholder | Attendu |
|---------|-------------|---------|
| Projet Vercel | `<VERCEL_STAGING_PROJECT>` | projet **staging** dédié, **pas** production |
| Scope déploiement | `<DEPLOYMENT_SCOPE>` | Preview / Staging — **pas** Production |
| Host `DATABASE_URL` | `<STAGING_HOST>` | host Postgres/Neon **staging**, distinct de prod. NAME only — **jamais** l’URL complète |
| Auth cron | `CRON_SECRET` (NAME) | défini en staging, distinct de prod. **Jamais la VALUE** |
| Tenant E2E | `<TENANT_COMPANY_ID>` | connu **localement** par l’ops. **Aucun tenant réel dans ce fichier** |
| Actor (futur P5 seulement) | `<SYSTEM_ACTOR_USER_ID>` | **non requis** P0–P4. Ne pas renseigner ici |

### EXPECTED_RESULT

Périmètre figé. Identité staging vs prod **non ambiguë**.

### VALIDATION

Checklist ops (valeurs locales, pas dans git) : projet ≠ prod ; host DB ≠ prod.

### STOP_CONDITION

**STOP** si environnement ambigu, projet/DB production, ou tentation de coller un tenant réel / un secret dans le runbook.

### ROLLBACK

N/A (aucun flag). Ne pas « corriger » en écrivant des secrets dans git.

---

## 4. P1 — Partner identities

| Champ | Contenu |
|-------|---------|
| **ID** | P1 |
| **STATUS** | Procédure **GO** |
| **Condition** | Partenaire **actif** + identité **domaine OU email** active (F3). Sans identité → sync fail-closed `NO_ACTIVE_PARTNER_IDENTITIES` |

### PRECHECK

P0 OK. Tenant local = `<TENANT_COMPANY_ID>`.

### CHANGE (écriture **optionnelle**, pas une vérif)

Si le registre est vide **et** qu’un ticket ops l’autorise :

```bash
npm run db:bootstrap:acquisition-partners
```

Cette commande **écrit**. Ce n’est **pas** une simple vérification. Ne pas l’exécuter « pour voir ».

Policies AUTO **parallèles** (rester **OFF** pour P1–P4 / Lot C) — via service admin, **pas** SQL ad hoc :

- `autoApproveEnabled = false`
- `autoConvertEnabled = false`
- `allowCreateClient = false`

`updatePartnerPolicy` **ne** bascule **pas** `active` (activate/deactivate séparés).

### VALIDATION

```bash
npm run db:check:acquisition-partners-readiness
```

**Attendu :** `companiesReady === companiesTotal`.

Complément : `GET /api/acquisition/ops-snapshot` (session ADMIN/SUPER_ADMIN) → `readiness.activePartnerDomains` **ou** `readiness.activePartnerEmails` non vides pour `<TENANT_COMPANY_ID>`.

### EXPECTED_RESULT

Identités actives. Aucun AUTO. Flags env inchangés par P1.

### STOP_CONDITION

Readiness registre KO ; tentation de détruire le registre ; policies AUTO déjà ON (NO-GO Lot C).

### ROLLBACK

**Ne pas** détruire le registre. **Pas** de SQL ad hoc. Policies restent OFF.

---

## 5. P2 — Master

| Champ | Contenu |
|-------|---------|
| **ID** | P2 |
| **STATUS** | Procédure **GO** Lot C |
| **Flag** | `PLANIFICATOR_ACQUISITION_ENABLED` |
| **ON** | exactement `"true"` |
| **ROLLBACK_VALUE** | unset / ≠ `"true"` |

### PRECHECK

P0 + P1. `ACQUISITION_ORCHESTRATOR_ALLOW_STUBS` **OFF**. Flags AUTO env **OFF**. Conversion brut **OFF**.

### CHANGE

`PLANIFICATOR_ACQUISITION_ENABLED=true` sur l’env **staging identifié**.

### EXPECTED_RESULT

Ouvre **uniquement** les **entrées gated** (crons / helpers qui vérifient le master).

**G-MASTER-SERVICE-SCOPE** : `registerIncomingMessage` et `maybeRunAutoDecisionAfterExtraction` **ne** sont **pas** gated par le master. Master OFF **seul** n’est **jamais** un rollback AUTO complet.

### VALIDATION

- `getAcquisitionFlagMatrix().master === true` (via snapshot ops → `readiness.flags.master`)
- Appel cron authentifié **sans** master : `skipReason: MASTER_DISABLED` (après `CRON_DISABLED` si le flag cron est aussi OFF)

Gates cron (OPS-001), ordre :

1. `CRON_DISABLED`
2. `MASTER_DISABLED`
3. `DOWNLOAD_CAPABILITY_DISABLED` **ou** `CONTENT_FETCH_DISABLED`
4. `EXTRACTION_DISABLED` (extraction unit cron seulement)

Auth Bearer **avant** ces gates.

Orchestrateur : `CRON_DISABLED` puis `MASTER_DISABLED`.

### STOP_CONDITION

Stubs ON ; confusion staging/prod ; AUTO déjà ON.

### ROLLBACK

Voir §15 — master **en dernier**. Si AUTO avait été armé (hors ce lot), couper AUTO **avant**.

---

## 6. P3 — Worker capabilities

| Champ | Contenu |
|-------|---------|
| **ID** | P3 |
| **STATUS** | Procédure **GO** Lot C |
| **Résultat** | Pipeline manuel / worker **prêt**. **Pas AUTO.** |

### PRECHECK

P2. Conversion brut **OFF**. AUTO env **OFF**. Stubs **OFF**.

### CHANGE — capacités (ordre graphe matrice)

Activer **uniquement** `=== "true"`, dans cet ordre documentaire :

1. `ACQUISITION_CONTENT_FETCH_ENABLED`
2. `ACQUISITION_EXTRACTION_ENABLED` (exige content)
3. `ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED`
4. `ACQUISITION_ATTACHMENT_ACCESS_ENABLED` **si** URLs signées nécessaires (n’ôte jamais AuthZ)

### Unit cron flags (possibles, **non préférés**)

À n’armer **que** si l’orchestrateur **n’est pas** utilisé pour le même tenant (§13) :

| NAME | Dépendance gate |
|------|-----------------|
| `ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED` | master + download capability |
| `ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED` | master + download capability |
| `ACQUISITION_CONTENT_CRON_ENABLED` | master + content fetch |
| `ACQUISITION_EXTRACTION_CRON_ENABLED` | master + content + extraction |
| `ACQUISITION_GMAIL_CRON_ENABLED` | master (unit Gmail, hors lease orchestrateur) |

`INV_*` signale incohérence ; **n’empêche pas** le process de démarrer.

### Interdits P3

| NAME | Valeur autorisée P3 |
|------|---------------------|
| `ACQUISITION_CONVERSION_ENABLED` | **OFF** |
| `ACQUISITION_AUTO_APPROVE_ENABLED` | **OFF** |
| `ACQUISITION_AUTO_CONVERT_ENABLED` | **OFF** |

### EXPECTED_RESULT

Extraction UI possible (contexte `UI_MANUAL` : extraction OK, **AUTO interdit**). Unit cron extraction = contexte **`UNIT_CRON`** : extraction possible, **AUTO interdit**, **pas de lease**.

Ne pas traiter le unit extraction cron comme « AUTO potentiel ». Le code actuel **interdit** AUTO hors `ORCHESTRATOR_AUTO` + ownership WeakMap.

### VALIDATION

`readiness.flags.conversionFully === false` ; `autoApprove === false` ; `autoConvert === false`. Capacités OFF → `skipReason` `CONTENT_FETCH_DISABLED` / `EXTRACTION_DISABLED` / `DOWNLOAD_CAPABILITY_DISABLED`.

### STOP_CONDITION

Conversion brut ON ; AUTO ON ; stubs ON ; unit crons **et** orchestrateur visés ensemble.

### ROLLBACK

§15 étapes 4–6 selon besoin (crons puis capacités puis master). AUTO déjà OFF.

---

## 7. P4 — Orchestrated `PENDING_REVIEW`

| Champ | Contenu |
|-------|---------|
| **ID** | P4 |
| **STATUS** | Procédure **GO** Lot C |
| **Flag préféré** | `ACQUISITION_ORCHESTRATOR_CRON_ENABLED === "true"` |

P4 aligne `docs/acquisition-ops-v2-staging-activation.md`. **Ce palier n’est pas GO AUTO.**

### PRECHECK — conditions OPS

- `ACQUISITION_CONVERSION_ENABLED` **OFF** → `conversionFully === false`
- `ACQUISITION_AUTO_APPROVE_ENABLED` **OFF**
- `ACQUISITION_AUTO_CONVERT_ENABLED` **OFF** (recommandation OPS B ; **pas** dans le calcul code A)
- `ACQUISITION_ORCHESTRATOR_ALLOW_STUBS` **OFF**
- Table `acquisition_orchestrator_leases` présente (`leaseTablePresent`)
- Identités P1 OK
- Dual unit cron ∥ orchestrateur = **STOP**
- Backup / migrate : selon staging Lot C **si** l’ops décide d’appliquer des migrations — **OPS-007 ne les exécute pas** et **ne contient aucune URL**

### Preuve code A

```text
getAcquisitionStagingReadiness(<TENANT_COMPANY_ID>).readyForOrchestratorE2E === true
```

**CODE CONTRACT A** (source `acquisition-staging-readiness.ts`, **inchangé** par ce runbook) — true **ssi** :

- `flags.master`
- **AND** `flags.orchestratorCron`
- **AND** `leaseTablePresent`
- **AND** identités présentes (`domains.length > 0` **OR** `emails.length > 0`)
- **AND** `!flags.conversionFully`
- **AND** `!flags.autoApprove`
- **AND** aucun `flagIssues` dont `code` commence par `INV_ORCHESTRATOR`

**`!flags.autoConvert` N’EST PAS une condition du calcul code.** `autoConvert` peut être true et `readyForOrchestratorE2E` true. **Ne pas** écrire « le code refuse autoConvert ».

**OPS CONTRACT B** (Lot C / 012-5 §11.2) : garder **aussi** `ACQUISITION_AUTO_CONVERT_ENABLED` et `ACQUISITION_CONVERSION_ENABLED` **OFF**. Étiquette : **recommandation OPS**, pas invariant code.

> **Phrase normative :** `readyForOrchestratorE2E=true` signifie uniquement **GO pipeline Lot C jusqu’à `PENDING_REVIEW`**. Cela ne signifie **JAMAIS GO AUTO**.

### CHANGE

`ACQUISITION_ORCHESTRATOR_CRON_ENABLED=true` sur l’env staging **après** P2+P3.

**Ne pas** activer les 5 unit cron flags / ticks du même tenant (§13).

Scheduler : **ce runbook ne déploie pas** le scheduler. Invocation manuelle / future :

```http
GET /api/cron/acquisition-orchestrator
Authorization: Bearer $CRON_SECRET
```

`$CRON_SECRET` = référence shell au NAME. **Jamais coller la VALUE.**

Cible fréquence OPS-002 : `*/10`. Staging Lot C : **5–15 min** acceptable. Hobby : Acquisition **hors** `vercel.json`. Présence de la route **≠** activation.

### EXPECTED_RESULT

Email allowlist (domaine ou adresse registre) :

`DRAFT_CREATED` → draft `PENDING_EXTRACTION` → content → extraction → **`PENDING_REVIEW`**

**Jamais** `APPROVED` auto. **Jamais** `CONVERTED` auto. Pas de `LEASE_STOLEN` inattendu. Logs préfixe `[acquisition-orchestrator]`. Contrôle doublons chantier (Lot C).

### VALIDATION

`GET /api/acquisition/ops-snapshot` (ADMIN/SUPER_ADMIN) : `readiness.readyForOrchestratorE2E === true` **et** counts cohérents. Journal : **pas** de `AUTO_APPROVE_ONLY` / `AUTO_APPROVE_CONVERT` inattendu. Booking intact (suites existantes — **ne pas** importer Acquisition→Booking).

### STOP_CONDITION

Readiness A KO **pour ce palier** ; dual unit∥orch ; stubs ON ; AUTO ON ; conversionFully ON ; confusion staging/prod ; impact Booking.

### ROLLBACK

§15 (AUTO déjà OFF → étapes 1–2 no-op ; puis conversion si jamais ON ; puis orchestrateur OFF ; capacités ; master). Lease : TTL ou release **même** `ownerRunId` — **pas** de reacquire.

**GO runtime P4** uniquement si la checklist Lot C staging §8 est verte **sur l’env visé**. Ce HEAD **n’affirme pas** que P4 est déjà armé.

---

## 8. P-STAGE — CODE CONTRACT A vs OPS CONTRACT B

### CODE CONTRACT A

Booléen `readyForOrchestratorE2E` — formule §7. **Ne teste pas** `!autoConvert`.

### OPS CONTRACT B

Pendant Lot C / P4 : conversion brut OFF **et** `ACQUISITION_AUTO_CONVERT_ENABLED` OFF, **en plus** de A.

### Confusion interdite

| Observation | Sens autorisé | Sens **interdit** |
|-------------|---------------|-------------------|
| `readyForOrchestratorE2E === true` | GO Lot C jusqu’à `PENDING_REVIEW` | **GO AUTO** / GO P5 / GO P6 |
| P5 `ACQUISITION_AUTO_APPROVE_ENABLED === "true"` | (futur, actuellement **NO-GO**) | Exiger encore `readyForOrchestratorE2E === true` |

**Dès P5 :** `readyForOrchestratorE2E` devient **false par design** (`!autoApprove` fait partie de A). **Ne pas** utiliser ce booléen comme gate P5/P6.

P-STAGE runtime proof (palier réellement exécuté vs reco B) **n’est pas clos** par la publication de ce fichier.

---

## 9. P5 — AUTO_APPROVE — **NO-GO**

| Champ | Contenu |
|-------|---------|
| **ID** | P5 |
| **STATUS** | **NO-GO** / **STOP** |
| **Mode cible 012-2** | `AUTO_APPROVE_ONLY` (convert effectif OFF) |
| **AUTO_RUNTIME_STATUS** | **OFF** |
| **CHANGE** | **Aucune.** Ce palier **ne fournit aucune commande** qui active `ACQUISITION_AUTO_APPROVE_ENABLED`. |

### WHY (actuel)

- TENANT_PILOT = **TBD** (012-2) — **hors git** ; ce runbook **ne choisit pas** le tenant
- **P-ACTOR** non prouvé
- Pilote **runtime 012-2 non exécuté** (SPEC 012-2 ≠ pilote)
- Code : `maybeRunAutoDecisionAfterExtraction` return immédiat si autoApprove env ≠ `"true"`
- Fencing **G-FENCE CLOSED** **≠** GO P5

### Préconditions futures (à prouver **avant** de transformer P5 en GO — lot ultérieur, pas ici)

1. Tenant pilote identifié **hors git** (ticket 012-2 runtime) — un seul tenant
2. `ACQUISITION_SYSTEM_ACTOR_USER_ID` défini en env (**pas** dans ce markdown) et validé **pour ce tenant** (§11)
3. Actor : existe, `active === true`, rôle `ADMIN` ou `SUPER_ADMIN`, `user.companyId === <TENANT_COMPANY_ID>`
4. Partner cible : `autoApproveEnabled = true` **et** `autoConvertEnabled = false`
5. `ACQUISITION_AUTO_CONVERT_ENABLED` **OFF**
6. `conversionFully` **OFF**
7. `allowCreateClient` inutilisé pour NEW — **aucun NEW** auto ; **aucun chantier auto** (contrat pilote 012-2)
8. Runtime 012-2 **exécuté et validé**
9. Journaux `HUMAN_REVIEW_REQUIRED` / `AUTO_APPROVE_ONLY` vérifiés ; **pas** `AUTO_APPROVE_CONVERT`
10. Chemin AUTO uniquement `ORCHESTRATOR_AUTO` + ownership — **pas** UI / UNIT_CRON
11. Dual unit cron ∥ orchestrateur toujours **STOP**

**Quand P5 serait un jour autorisé :** ne **plus** exiger `readyForOrchestratorE2E` (false by design).

**P5 reste STOP.**

---

## 10. P6 — AUTO_CONVERT — **NO-GO**

| Champ | Contenu |
|-------|---------|
| **ID** | P6 |
| **STATUS** | **NO-GO** / **STOP** |
| **Mode cible 012-3** | `AUTO_APPROVE_CONVERT` |
| **CHANGE** | **Aucune commande d’activation.** |

### WHY (actuel)

- 012-2 runtime **non validé**
- **P-ACTOR** non validé
- **P-CONV** non prouvé
- 012-3 runtime **non exécuté**
- **G-FENCE CLOSED** **ne vaut pas** GO P6

### Préconditions futures (lot ultérieur — pas ici)

1. 012-2 runtime **validé**
2. P-ACTOR **validé**
3. P-CONV **prouvé**
4. 012-3 runtime **exécuté et validé**
5. `conversionFully` actif **seulement au bon moment** (master ∩ `ACQUISITION_CONVERSION_ENABLED`)
6. autoApprove **actif** (env ∩ partner) — P6 **après** P5, pas à la place
7. autoConvert **env** ∩ partner `autoConvertEnabled`
8. `allowCreateClient` **uniquement si NEW** (012-0 F7) ; défaut `false`
9. AUTO uniquement via `ORCHESTRATOR_AUTO`

AUTO convert effectif = env `ACQUISITION_AUTO_CONVERT_ENABLED` ∩ partner `autoConvertEnabled` ∩ `conversionFully` ∩ policy `AUTO_APPROVE_CONVERT` ∩ actor SYSTEM valide. Conversion **manuelle** ne dépend pas du seul `autoConvertEnabled`.

`INV_AUTO_CONVERT_*` **détecte**, **ne crash pas**.

**P6 reste STOP.**

---

## 11. SYSTEM ACTOR — template de preuve

Documenter **uniquement** :

```text
ACQUISITION_SYSTEM_ACTOR_USER_ID=<SYSTEM_ACTOR_USER_ID>
```

**Jamais** de valeur réelle dans ce fichier ni dans un commit.

Non requis pour P0–P4. Obligatoire **avant** tout futur P5.

### Procédure future de preuve (ops local, hors markdown)

Source : `resolveValidatedSystemActor` (`system-actor.ts`).

| Étape | Attendu | Échec |
|-------|---------|--------|
| Env défini, trim non vide | `getAcquisitionSystemActorUserId()` | `SYSTEM_ACTOR_MISSING` / `env_unset` |
| `user.findFirst({ id })` | user existe | `SYSTEM_ACTOR_INVALID` / `user_not_found` |
| `user.active === true` | actif | `user_inactive` |
| `user.role` ∈ `{ADMIN, SUPER_ADMIN}` | rôle autorisé | `role_forbidden` |
| `user.companyId === <TENANT_COMPANY_ID>` | même tenant | `tenant_mismatch` |
| `companyId` palier non vide | | `company_missing` |

Un seul env userId ⇒ **un seul tenant** possible nativement.

### Échec attendu

Aucun approve / convert automatique via `maybeRunAutoDecisionAfterExtraction`. Journal possible `decisionCode: "SYSTEM_ACTOR_INVALID"`. Ne pas journaliser l’id réel dans les docs.

**P-ACTOR** reste PRECONDITION (non clos par OPS-007).

---

## 12. Inventaire des flags

Convention : booléens **ON** ssi `=== "true"`.

### MASTER

| NAME | Rôle |
|------|------|
| `PLANIFICATOR_ACQUISITION_ENABLED` | Kill-switch **d’entrée gated**. Pas rollback AUTO suffisant |

### UNIT CRONS

| NAME | Rôle |
|------|------|
| `ACQUISITION_GMAIL_CRON_ENABLED` | Unit cron Gmail Acquisition (hors lease orchestrateur) |
| `ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED` | Unit cron download |
| `ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED` | Unit cron recovery |
| `ACQUISITION_CONTENT_CRON_ENABLED` | Unit cron content |
| `ACQUISITION_EXTRACTION_CRON_ENABLED` | Unit cron extraction — **AUTO interdit** (`UNIT_CRON`) |

### ORCHESTRATOR

| NAME | Rôle |
|------|------|
| `ACQUISITION_ORCHESTRATOR_CRON_ENABLED` | Cron orchestrateur V2 (5 steps in-process, **une** lease) |

### CAPABILITIES

| NAME | Rôle |
|------|------|
| `ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED` | Capacité download PJ |
| `ACQUISITION_ATTACHMENT_ACCESS_ENABLED` | Accès PJ signé (AuthZ inchangée) |
| `ACQUISITION_CONTENT_FETCH_ENABLED` | Capacité fetch contenu |
| `ACQUISITION_EXTRACTION_ENABLED` | Capacité extraction |

### CONVERSION

| NAME | Rôle |
|------|------|
| `ACQUISITION_CONVERSION_ENABLED` | Flag **brut**. `conversionFully` = master ∩ brut |

### AUTO

| NAME | Rôle | Palier |
|------|------|--------|
| `ACQUISITION_AUTO_APPROVE_ENABLED` | Kill-switch env auto-approve (early return service) | P5 **NO-GO** |
| `ACQUISITION_AUTO_CONVERT_ENABLED` | Kill-switch env auto-convert | P6 **NO-GO** |

### NAME ONLY (pas un palier ON/OFF)

| NAME | Rôle |
|------|------|
| `ACQUISITION_SYSTEM_ACTOR_USER_ID` | Placeholder `<SYSTEM_ACTOR_USER_ID>` |
| `ACQUISITION_AUTO_MIN_CONFIDENCE` | Seuil policy ; défaut code `0.75` — ne pas inventer un seuil « plus sûr » |
| `ACQUISITION_EXTRACTION_PROVIDER` | `deterministic` \| `anthropic` (défaut `deterministic`) |
| `CRON_SECRET` | Auth Bearer cron — **NAME only, jamais VALUE** |

Budgets / TTL (`*_MAX_DURATION_MS`, `ACQUISITION_ORCHESTRATOR_LEASE_TTL_MS`, plafonds batch) : **hors** activation métier P0–P6. Defaults code si unset.

### STUBS (hors P0–P6 métier)

| NAME | Règle |
|------|-------|
| `ACQUISITION_ORCHESTRATOR_ALLOW_STUBS` | Booléen `=== "true"`. **Tests/debug only.** **MUST BE OFF métier.** STOP si ON en staging métier (faux SUCCESS). Hors `getAcquisitionFlagMatrix()`. |

### Partner DB (hors env, condition parallèle)

`AcquisitionPartner.autoApproveEnabled` / `autoConvertEnabled` / `allowCreateClient` — défaut `false`.

### Hors scope de ce runbook

Values secrètes ; Booking ; `/api/cron/gmail-scan` ; transformer `INV_*` en crash ; 012-6 / 012-7 ; Gmail intra-page fencing.

---

## 13. UNIT CRON RULE

**Si** `ACQUISITION_ORCHESTRATOR_CRON_ENABLED` est utilisé pour le chemin pipeline (et, plus tard, le chemin AUTO) :

**ne pas** exécuter en parallèle :

- `/api/cron/acquisition-gmail-sync`
- `/api/cron/acquisition-attachment-download`
- `/api/cron/acquisition-attachment-recovery`
- `/api/cron/acquisition-content-fetch`
- `/api/cron/acquisition-extraction`

Règles :

- unit crons **hors lease** orchestrateur — **pas de faux fencing** (`UNIT_CRON_GAP = PRECONDITION_ONLY`)
- **ne pas** écrire « UNIT_CRON FENCED »
- extraction **UNIT_CRON** ⇒ **AUTO interdit**
- dual unit cron ∥ orchestrateur = **STOP OPS** (012-4 / staging §5)
- **ne pas inventer** de lease unit cron

UI manuelle : extraction OK, AUTO interdit, **pas** de lease UI.

---

## 14. Scheduling

| Fait | Détail |
|------|--------|
| **Réellement déployé (routes)** | Endpoints HTTP Acquisition existent, auth `Authorization: Bearer $CRON_SECRET` |
| **`vercel.json`** | **Uniquement** Booking/chantiers : `/api/cron/chantiers` `0 5 * * *` ; `/api/cron/gmail-scan` `0 8 * * *`. **Acquisition hors vercel.json** (Hobby : pas de cron sub-quotidien) |
| **Scheduler externe** | Cible privilégiée Raspberry Pi / ordonnanceur contrôlé — **non configuré** (OPS-002). **OPS-007 ne déploie pas le scheduler** |
| **Présence route ≠ activation** | Sans flags : **200** `SKIPPED` + `skipReason` |
| **Recommandé P4** | Orchestrateur, cible OPS-002 `*/10` ; staging 5–15 min acceptable |
| **Interdit en parallèle** | Empiler les 5 unit crons **et** l’orchestrateur sur le même tenant |
| **Interdit** | Déclarer Acquisition dans `vercel.json` ; toucher Booking / `gmail-scan` ; prétendre que ce lot configure le Pi |

Auth : absent/invalide → **401**. Succès/skip → **200**. Pas d’exposition de tokens Gmail / URLs signées / stack Prisma.

---

## 15. Rollback

**Ordre obligatoire** (réduction des risques AUTO — 012-5 §15). Complète le rollback Lot C staging §7 (orchestrateur puis master) par la coupure AUTO **explicite**.

1. `ACQUISITION_AUTO_CONVERT_ENABLED` → OFF (unset / ≠ `"true"`)
2. `ACQUISITION_AUTO_APPROVE_ENABLED` → OFF — **obligatoire** pour stopper le hook. **MASTER OFF SEUL = ROLLBACK AUTO INSUFFISANT.**
3. `ACQUISITION_CONVERSION_ENABLED` → OFF si le palier l’exige (casse `conversionFully`)
4. `ACQUISITION_ORCHESTRATOR_CRON_ENABLED` et/ou unit cron flags → OFF
5. Capacités worker (`EXTRACTION` / `CONTENT_FETCH` / `ATTACHMENT_DOWNLOAD` / `ATTACHMENT_ACCESS`) → OFF si besoin d’arrêter UI / I/O
6. `PLANIFICATOR_ACQUISITION_ENABLED` → OFF **en dernier** = kill-switch **uniquement** des entrées gated

Toujours :

- **conserver** les journaux `acquisition_decision_journals`
- **ne pas** supprimer drafts / messages / PJ
- **aucune** déconversion (`CONVERTED` → …)
- **ne pas** toucher Booking / `gmail-scan` / cursor Booking
- lease : expirer TTL **ou** release **même** `ownerRunId` — **pas de reacquire**
- stubs **OFF**

Les autres flags à couper **après** AUTO dépendent du palier (P4 : orchestrateur ; P3 : capacités ; P2 : master).

---

## 16. Vérifications futures (templates — **non exécutées** par la publication)

Ne coller **aucune** VALUE secrète. Remplacer les placeholders **hors git**.

### Flags / readiness / identités

```bash
npm run db:check:acquisition-partners-readiness
# attendu : companiesReady === companiesTotal
```

```http
GET /api/acquisition/ops-snapshot
```

Session **ADMIN** ou **SUPER_ADMIN**. Corps attendu : `ops` + `readiness` (`flags`, `flagIssues`, `readyForOrchestratorE2E`, `leaseTablePresent`, identités, counts). **Ne pas** interpréter `readyForOrchestratorE2E` comme GO AUTO.

### Migrate (staging host only — NAME `<STAGING_HOST>`)

```bash
npx prisma migrate status
```

OPS-007 **n’applique pas** `migrate deploy`.

### Orchestrateur (auth NAME only) — **WRITE métier**

`GET /api/cron/acquisition-orchestrator` est un **WRITE métier**. Malgré la méthode HTTP GET, cet endpoint peut déclencher le pipeline Acquisition et produire des écritures (messages / drafts / content / extraction). Ce n’est **pas** une lecture seule.

```http
GET /api/cron/acquisition-orchestrator
Authorization: Bearer $CRON_SECRET
```

### Logs / journal / lease

- stdout : `[acquisition-orchestrator]`, `[acquisition-auto-decision]`
- `LEASE_STOLEN` **inattendu** = STOP
- `acquisition_decision_journals.decisionCode`
- table `acquisition_orchestrator_leases` (présence, pas dump de secrets)

### Après rollback

Vérifier via snapshot / matrix :

- `matrix.autoApprove === false`
- `matrix.autoConvert === false`

### Autres

- T-SEC : grep ce fichier — aucune VALUE secrète
- Booking : suites `tests/booking/**` existantes ; **pas** d’import Acquisition→Booking
- P0–P4 : **pas** de `AUTO_APPROVE_ONLY` / `AUTO_APPROVE_CONVERT` inattendu

`npm run db:bootstrap:acquisition-partners` = **CHANGE** P1, **pas** une vérif.

---

## 17. NO-GO matrix

| Palier | STATUS | WHY | REQUIRED PROOF |
|--------|--------|-----|----------------|
| **P0** | Procedure **GO** / runtime **PRECONDITION** | Distinguer staging ≠ prod | Placeholders env ; **pas** de tenant dans git ; STOP si ambigu |
| **P1** | **GO** procedure | F3 identités | `companiesReady === companiesTotal` ; domain **ou** email ; policies AUTO OFF |
| **P2** | **GO** procedure Lot C | Master gated | `matrix.master === true` ; stubs OFF ; AUTO OFF |
| **P3** | **GO** procedure Lot C | Graphe content → extraction ; download → recovery/access | conversion brut OFF ; AUTO OFF ; gates skipReason si OFF |
| **P4** | **GO** procedure Lot C | Pipeline jusqu’à `PENDING_REVIEW` | **A** `readyForOrchestratorE2E` ; **B** autoConvert/conversion OFF ; E2E email ; pas dual unit∥orch ; **pas GO AUTO** |
| **P5** | **NO-GO** | 012-2 runtime absent ; TENANT/P-ACTOR absents ; AUTO OFF | Voir §9 — **aucune** commande d’activation |
| **P6** | **NO-GO** | 012-3 / P-CONV absents ; convert OFF | Voir §10 — 012-2 validé + P-CONV **requis plus tard** |

---

## 18. Sécurité

Ce fichier **ne contient pas** :

- secret réel, token, cookie, credential
- `DATABASE_URL` complète
- VALUE `CRON_SECRET`
- userId réel
- tenant / `companyId` réel

Placeholders autorisés : `<TENANT_COMPANY_ID>`, `<SYSTEM_ACTOR_USER_ID>`, `<STAGING_HOST>`, `<VERCEL_STAGING_PROJECT>`, `<DEPLOYMENT_SCOPE>`, `$CRON_SECRET` (référence NAME).

Auth cron : **mécanisme** Bearer, pas la valeur.

---

## 19. STOP CONDITIONS (rappel)

Arrêt immédiat d’une étape si :

- tenant pilote non identifié **pour un palier AUTO** (P5/P6 déjà STOP)
- actor non valide pour le tenant (**P-ACTOR**)
- policies partenaire non lues / non prouvées (AUTO)
- readiness **A** KO **pour P4** (ne pas l’exiger après un futur autoApprove ON)
- `AUTO_APPROVE_CONVERT` inattendu
- conversionFully ON alors qu’interdit (Lot C / 012-2)
- P5 large ou P6 alors que `AUTO_RUNTIME_STATUS = OFF`
- logs / journal insuffisants
- impact Booking / `gmail-scan`
- `INV_*` critique **détecté** → investiguer (signal ops, **pas** crash auto)
- projet / DB production pour un run staging
- unit crons **et** orchestrateur ON ensemble
- stubs ON en staging métier

---

## 20. Statut final

| Clé | Valeur |
|-----|--------|
| **OPS_007_STATUS** | **CREATED** |
| **RUNBOOK_SPEC_READY** | **YES** (contrat 012-5) |
| **RUNBOOK_READY_FOR_P0_P4** | **YES** |
| **P5_STATUS** | **NO-GO** |
| **P6_STATUS** | **NO-GO** |
| **AUTO_RUNTIME_STATUS** | **OFF** |
| **OPS_007_READY_FOR_AUTO** | **NO** |
| **OPS_007_READY** (012-5 : activation AUTO réelle) | **NO** |
| **G-RB (runbook publié)** | **CLOSED** |
| **G-RB (AUTO / production ready)** | **non** — ne pas confondre |
| **RUNTIME_READY AUTO** | **NO** |
| **Production** | **TBD / HORS SCOPE** |

**Runbook publié ≠ AUTO activation ready ≠ production ready.**

P0–P4 : procédure disponible, alignée Lot C. Exécution réelle = décision ops **hors** ce commit, sur env staging identifié, **sans** AUTO.

---

## Historique

| Date | Note |
|------|------|
| 2026-08-17 | Création OPS-007 `docs/RB-PLAN-ACQ-001-activation-flags.md` ; HEAD `61f04e6` ; P5/P6 **NO-GO** ; `AUTO_RUNTIME_STATUS = OFF` ; aucun secret ; aucun tenant/actor réel |
