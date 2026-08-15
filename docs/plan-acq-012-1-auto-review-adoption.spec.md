# PLAN-ACQ-012-1 — Adoption AUTO / REVIEW

| Champ | Valeur |
|-------|--------|
| **Ticket** | PLAN-ACQ-012-1 |
| **Type** | SPEC de gouvernance documentaire (documentation seule) |
| **Statut** | DRAFT — prêt pour revue |
| **Prérequis** | PLAN-ACQ-012-0 sur `main` (`6c685e29afd982d43fd49a241dacad7f3fc91df3`) |
| **Source normative** | `docs/plan-acq-012-0-auto-review-guardrails.spec.md` |
| **Implémentation métier** | **Interdite** |
| **Activation runtime** | **Interdite** |

---

## 1. Rôle

PLAN-ACQ-012-1 est un lot de **gouvernance documentaire**.

Il sert exclusivement à :

1. **adopter** PLAN-ACQ-012-0 comme source normative des garde-fous AUTO / REVIEW ;
2. **figer** les critères AUTO / REVIEW tels que déjà écrits dans 012-0 (aucune nouvelle règle métier) ;
3. **figer** les garde-fous pré-activation (fail-closed, policies, actor, tenant, etc.) ;
4. **produire** une checklist GO / NO-GO exploitable avant tout lot d’activation ;
5. **ne rien activer** au runtime (flags, scheduler, policies runtime, autoApprove, autoConvert).

**Aucune implémentation métier.** Aucune modification code / test / Prisma / Booking / gmail-scan.

Ce lot **remplace** le squelette TBD de 012-0 §13 pour PLAN-ACQ-012-1 : l’objectif, les preuves et le critère de sortie sont définis **ici**.

---

## 2. Source normative

| Document | Rôle |
|----------|------|
| `docs/plan-acq-012-0-auto-review-guardrails.spec.md` | **Source normative unique** des invariants, critères AUTO/REVIEW, gaps, périmètres de garantie |
| `docs/plan-acq-012-1-auto-review-adoption.spec.md` | **Ce document** — adoption, gel, checklist, classement des gaps, critère de sortie 012-1 |

Toute divergence future (seuils, reasons, invariants, vocabulaire decisionCode/reasons/logs) **doit** passer par une **modification explicite** de PLAN-ACQ-012-0 (ou amendement normatif référencé).
012-1 **ne crée pas** de règle concurrente ; il **cite** 012-0.

Nomenclature (inchangée, 012-0 §2) :

- `PLAN-ACQ-012-LOT-1.x` ≠ `PLAN-ACQ-012-0…7`
- toujours utiliser le nom complet du ticket

---

## 3. Critères AUTO figés

Reprise **stricte** de 012-0 §6 — **aucun nouveau seuil**, **aucune modification de policy**.

Source code de référence (déjà documentée 012-0) :

- policy pure : `src/lib/acquisition/policy/auto-decision.policy.ts`
- orchestration : `src/lib/acquisition/policy/auto-decision.service.ts`

### 3.1 `decisionCode` policy (figés)

| `decisionCode` | Signification (012-0 §6.2) |
|----------------|----------------------------|
| `HUMAN_REVIEW_REQUIRED` | Pas d’auto-approve policy |
| `AUTO_APPROVE_ONLY` | Seuils OK ; convert effectif OFF |
| `AUTO_APPROVE_CONVERT` | Seuils OK ; convert effectif ON |

### 3.2 Préconditions d’AUTO — chemin pipeline nominal (figées)

Sur le chemin d’entrée **gated** (extraction ayant passé son check master, puis auto-decision), AUTO n’est possible que si la conjonction 012-0 §6.1 est vraie, notamment :

- `ACQUISITION_AUTO_APPROVE_ENABLED === "true"`
- partner actif résolu + `autoApproveEnabled === true`
- `resolveValidatedSystemActor` OK
- draft `PENDING_REVIEW`
- lectures scopées `companyId`
- données / confiances / warnings / duplicate **détecté** / ambiguïté / injection / documents selon policy

**Master :** typiquement ON sur le chemin extraction gated ; **pas** un check interne de `maybeRunAutoDecisionAfterExtraction` (012-0 **G-MASTER-SERVICE-SCOPE**).

Pour tenter `AUTO_APPROVE_CONVERT` puis convert (012-0 §6.1 / §7) :

- env `ACQUISITION_AUTO_CONVERT_ENABLED === "true"`
- partner `autoConvertEnabled === true`
- conversion métier fully = master ∩ `ACQUISITION_CONVERSION_ENABLED`
- `allowCreateClient` **uniquement** pour clientMode NEW

Fallback unique de la policy pure : `HUMAN_REVIEW_REQUIRED` (012-0 §6.4).

---

## 4. Critères REVIEW figés

### 4.1 Reasons policy (`reasons[]` de `evaluateAutoDecision`) — liste figée 012-0 §6.3

| Reason code |
|-------------|
| `AUTO_APPROVE_DISABLED` |
| `MISSING_WORKSITE_NAME` |
| `INVALID_DATES` |
| `AMBIGUOUS_ADDRESS` |
| `MISSING_CLIENT_IDENTITY` |
| `AMBIGUOUS_CLIENT` |
| `POTENTIAL_DUPLICATE` |
| `PROMPT_INJECTION_RISK` |
| `REQUIRED_DOCUMENT_UNREADABLE` |
| `BLOCKING_WARNINGS` |
| `LOW_CONFIDENCE:worksiteName` |
| `LOW_CONFIDENCE:requestedStartDate` |
| `LOW_CONFIDENCE:requestedEndDate` |

### 4.2 Vocabulaire — ne pas fusionner (012-0 §6.5)

| Couche | Exemples | Rôle |
|--------|----------|------|
| **`decisionCode` journal (policy)** | `HUMAN_REVIEW_REQUIRED`, `AUTO_APPROVE_ONLY`, `AUTO_APPROVE_CONVERT` | Sortie `evaluateAutoDecision` |
| **`decisionCode` journal (post-policy)** | `SYSTEM_ACTOR_INVALID` | Append distinct si actor non OK après décision AUTO |
| **`reasons[]` journal** | Reasons policy ; ou `[systemActor.code, systemActor.reason]` | Tableau string du journal |
| **Codes résolution actor** | `SYSTEM_ACTOR_MISSING` (env unset), `SYSTEM_ACTOR_INVALID` (user/tenant/rôle/actif) | Retour `resolveValidatedSystemActor` — **pas** le `decisionCode` journal quand missing |
| **Logs stdout** | `DECISION`, `SYSTEM_ACTOR_INVALID`, `AUTO_APPROVE_FAILED`, `AUTO_CONVERT_SKIPPED_*`, `AUTO_CONVERT_BLOCKED_DUPLICATE`, `AUTO_CONVERT_RESULT` | Observabilité |
| **Skip reason sync/cron** | `FEATURE_DISABLED`, `NO_ACTIVE_PARTNER_IDENTITIES`, `CRON_DISABLED`, … | Autre couche |

`SYSTEM_ACTOR_MISSING` peut apparaître dans **reasons**, pas comme `decisionCode` journal (toujours `SYSTEM_ACTOR_INVALID` dans ce cas — 012-0 §6.5).

---

## 5. Garde-fous figés

Gel documentaire des invariants 012-0 (aucune réécriture métier) :

| Garde-fou | Portée figée (012-0) |
|-----------|----------------------|
| Flags fail-closed | Absents / ≠ `"true"` ⇒ OFF |
| Partner policy | Env ∩ partner ; défauts OFF ; fallback domaine borné |
| System actor | Env userId unique ; validité = tenant cible + rôle + actif |
| Tenant isolation | Lectures/écritures sensibles scopées `companyId` |
| `allowCreateClient` | **NEW only** ; EXISTING indépendant |
| Duplicate | Heuristique bornée (500 / 2000) — **pas** preuve globale d’absence |
| Idempotence | Bornée aux mécanismes 012-0 §9 (message, attachmentKey, version review, convert, cursor) |
| Master scope | Kill-switch d’**entrée gated** — pas universel par service (**G-MASTER-SERVICE-SCOPE**) |
| Booking isolation | Pipelines disjoints ; pas d’import Acquisition → Booking ; pas toucher gmail-scan |
| Fencing non-Gmail | Heartbeat mid-worker hors Gmail **incomplet** (**G-FENCE**) |
| `INV_*` | Détection matrice seule — **non** enforcement cron (**G-INV**) |

Inertie crons (012-0 §5) : distinguer **écriture métier** vs **écriture technique** ; SKIPPED ≠ toujours zéro écriture (`getOrCreate` possible avant `NO_ACTIVE_PARTNER_IDENTITIES`).

---

## 6. Checklist GO / NO-GO

Checklist **documentaire** pour la gate 012-1 et pour préparer (sans activer) les lots futurs.

Légende :

- **GO** — élément prouvé / satisfait pour **ce** lot de gouvernance, ou règle figée vérifiable sans activation
- **NO-GO** — interdit ou non satisfait pour une activation auto (ne pas activer)
- **PRECONDITION** — requis avant activation auto future ; **non** prouvé comme « ready to activate » par 012-1 seul
- **GAP** — écart documenté dans 012-0 ; non résolu par 012-1

| # | Item | Classe | Note |
|---|------|--------|------|
| C1 | PLAN-ACQ-012-0 validée / présente sur `main` | **GO** | Commit `6c685e2` |
| C2 | Critères AUTO/REVIEW figés sans divergence avec 012-0 | **PRECONDITION** | Gel défini dans le draft §§3–4 ; acquis lorsque PLAN-ACQ-012-1 est approuvée |
| C3 | Partner policies **explicites** par tenant (ops) | **PRECONDITION** | Requis avant auto ; non audité runtime ici |
| C4 | System actor valide pour tenant cible | **PRECONDITION** | **P-ACTOR** |
| C5 | Tenant readiness / registre | **PRECONDITION** | Identités actives avant scan large |
| C6 | Staging readiness interprétée (§12.1 code vs §12.2 ops) | **PRECONDITION** | **P-STAGE** |
| C7 | `autoApprove` effectif (env ∩ partner) | **PRECONDITION** | Pour Lot C `readyForOrchestratorE2E` : code exige `!flags.autoApprove` ; 012-1 **interdit** l’activation |
| C8 | `conversionFully` | **PRECONDITION** | Code `readyForOrchestratorE2E` exige `!flags.conversionFully` ; ≠ `autoConvert` seul |
| C9 | Duplicate protection (heuristique) | **PRECONDITION** | Mécanisme existant ; validation activation = tests + scénario ; pas garantie globale |
| C10 | Idempotence bornée §9 | **PRECONDITION** | Mécanismes existants ; validation sur périmètres documentés |
| C11 | Fencing suffisant pour auto/convert large | **GAP** | **G-FENCE** — bloque GO auto large (012-0 §11.2) |
| C12 | Rollback documenté (flags / master sur entrées gated) | **PRECONDITION** | Runbook flags OPS-007 encore **G-RB** |
| C13 | Logs / journal exploitables | **PRECONDITION** | Chemins log documentés 012-0 ; preuve ops non fournie par 012-1 |
| C14 | Booking isolation | **GO** | Règle figée 012-0 §10 + constat structurel ; 012-1 n’y touche pas |
| C15 | Scheduler inchangé (dans 012-1) | **GO** | Interdiction de ce lot ; aucune modification scheduler |
| C16 | Activation runtime interdite dans 012-1 | **GO** | Contrat de ce lot ; aucune activation dans le périmètre 012-1 |
| C17 | `INV_*` comme kill-switch | **NO-GO** / **GAP** | **G-INV** — ne pas s’y fier pour activer |
| C18 | Activation autoApprove / autoConvert dans 012-1 | **NO-GO** | Interdit §8 |

**Règle :** ne pas marquer **GO** un élément d’activation non prouvé. Les items C3–C13 restent PRECONDITION ou GAP jusqu’à preuves ops / lots futurs.

---

## 7. État actuel des gaps

Repris de 012-0 §16 — **sans résolution** dans 012-1.

| ID | STATUS | IMPACT | BLOCKS_AUTO_ACTIVATION | EVIDENCE_REQUIRED |
|----|--------|--------|------------------------|-------------------|
| **G-INV** | Ouvert | `INV_*` détectés, non bloquants process / non gate cron | **YES** si on s’y fie comme kill-switch ; sinon mitigé par vérif flags explicites | Checklist flags cohérents ; ne pas traiter `INV_*` comme enforcement |
| **G-FENCE** | Ouvert | Heartbeat mid-worker non-Gmail incomplet | **YES** pour auto/convert **large** ou traitements longs (012-0 §11.2) | Fencing livré **ou** preuve `maxDurationMs` &lt; TTL+marge |
| **G-RB** | Ouvert | Runbook `RB-PLAN-ACQ-001-activation-flags.md` (OPS-007) absent | **YES** pour rollback / activation ops documentée | Runbook publié (hors 012-1) |
| **G-MASTER-SERVICE-SCOPE** | Ouvert | Master non enforceé dans chaque service interne | **YES** si appels directs hors entrées gated | Respecter chemins d’entrée documentés ; pas d’appel direct non gated en ops |
| **P-ACTOR** | Précondition | System actor env valide pour tenant cible | **YES** pour AUTO effectif | UserId env + appartenance tenant + rôle + actif |
| **P-CONV** | Précondition | Conversion fully + policies auto-convert ; `allowCreateClient` si NEW | **YES** pour auto-convert | Flags + partner + actor |
| **P-STAGE** | Précondition | Distinguer contrat code `readyForOrchestratorE2E` vs reco ops | **YES** si mal interprété (faux GO staging) | Lire 012-0 §12.1 / §12.2 avant activation |

012-1 **classifie** ces gaps ; il **ne les ferme pas**.

---

## 8. Interdictions

PLAN-ACQ-012-1 **ne doit pas** :

1. activer `ACQUISITION_AUTO_APPROVE_ENABLED` / partner `autoApproveEnabled` ;
2. activer `ACQUISITION_AUTO_CONVERT_ENABLED` / partner `autoConvertEnabled` ;
3. changer la conversion métier ou ses flags runtime ;
4. changer le scheduler (Vercel, Raspberry Pi, crons) ;
5. changer Vercel / Raspberry Pi / production ;
6. toucher Booking / `/api/cron/gmail-scan` ;
7. toucher Prisma / migrations ;
8. modifier policies partenaires **runtime** (DB / admin) dans le cadre de ce lot ;
9. modifier le code / les tests Acquisition ;
10. élargir le scope vers PLAN-ACQ-012-2+ (fonctionnalités / activations).

---

## 9. Preuves requises

Pour considérer PLAN-ACQ-012-1 **terminé**, preuves **documentaires** uniquement :

| # | Preuve | Vérifiable par |
|---|--------|----------------|
| P1 | PLAN-ACQ-012-0 approuvée / sur `main` | Commit `6c685e2` + présence du fichier SPEC |
| P2 | Critères AUTO/REVIEW figés **sans divergence** avec 012-0 §§6–7 | Revue croisée 012-1 §§3–4 vs 012-0 |
| P3 | Checklist GO/NO-GO créée et classée (§6) | Présence de ce document |
| P4 | Gaps G-INV / G-FENCE / G-RB / G-MASTER-SERVICE-SCOPE / P-ACTOR / P-CONV / P-STAGE classés (§7) | Table §7 complète |
| P5 | Aucune activation runtime dans le lot 012-1 | `git` : pas de changement flags/env/scheduler dans le lot ; doc-only |
| P6 | Aucune modification code métier | `git status` / diff : uniquement doc 012-1 |
| P7 | Aucune modification Booking / gmail-scan | Idem |

La résolution des gaps **G-*** / **P-*** **n’est pas** une preuve requise de DONE 012-1 (sauf si une preuve ci-dessus l’exige — ce n’est pas le cas).

---

## 10. Critère de sortie

**PLAN-ACQ-012-1 est DONE lorsque :**

1. la SPEC `docs/plan-acq-012-1-auto-review-adoption.spec.md` est **approuvée** ;
2. les critères AUTO / REVIEW sont **figés** et **sans divergence** avec PLAN-ACQ-012-0 ;
3. la checklist GO / NO-GO (§6) est **complète** (chaque item classé GO / NO-GO / PRECONDITION / GAP) ;
4. chaque gap listé §7 est **classé** (STATUS, IMPACT, BLOCKS_AUTO_ACTIVATION, EVIDENCE_REQUIRED) ;
5. **aucune** activation runtime n’a eu lieu dans le cadre de 012-1 ;
6. **aucun** code métier n’a été modifié dans le cadre de 012-1 ;
7. Booking / gmail-scan / Prisma / scheduler n’ont **pas** été touchés.

DONE **n’exige pas** la fermeture de G-FENCE, G-INV, G-RB, G-MASTER-SERVICE-SCOPE, ni la satisfaction ops de P-ACTOR / P-CONV / P-STAGE.

---

## 11. Relation avec 012-2+

- PLAN-ACQ-012-1 est une **gate de gouvernance** uniquement.
- Il **ne définit pas** les fonctionnalités, activations, ni critères de sortie des lots `PLAN-ACQ-012-2` … `PLAN-ACQ-012-7`.
- Les squelettes TBD de 012-0 §13 pour 012-2+ restent **hors scope** de 012-1.
- Aucun travail 012-2+ (auto-approve only, auto-convert, fencing, runbook flags, etc.) n’est autorisé sous le ticket 012-1.

---

## 12. Hors scope

- implémentation code / test ;
- Prisma / migrations ;
- Gmail parser / mapper / OAuth ;
- Booking / gmail-scan ;
- Vercel / Raspberry Pi / scheduler ;
- flags runtime / production rollout ;
- fermeture des gaps §7 ;
- SPEC détaillée des lots 012-2+.

---

## Historique

| Date | Note |
|------|------|
| 2026-08-15 | Création SPEC 012-1 suite audit `012_1_SCOPE_NOT_DEFINED` ; adoption documentaire de 012-0 (`6c685e2`) |
