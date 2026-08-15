# PLAN-ACQ-012-2 — Auto-Approve Pilot

| Champ | Valeur |
|-------|--------|
| **Ticket** | PLAN-ACQ-012-2 |
| **Type** | SPEC normative d’encadrement d’activation pilote (documentation seule) |
| **Statut** | DRAFT — prêt pour revue |
| **HEAD de référence** | `0cfce21dd17f0eb97f29ca3f7a754b464ef9ee10` |
| **Sources normatives** | `docs/plan-acq-012-0-auto-review-guardrails.spec.md`, `docs/plan-acq-012-1-auto-review-adoption.spec.md` |
| **Implémentation métier** | **Interdite** dans ce lot |
| **Activation runtime** | **Interdite** dans ce lot |

---

## 1. Rôle

PLAN-ACQ-012-2 **prépare et encadre** une activation pilote future du mode :

**`AUTO_APPROVE_ONLY`**

sur **un** tenant explicitement sélectionné.

Cette SPEC :

- fige le contrat d’activation (mode, interdictions, préconditions, preuves, rollback) ;
- **ne réalise aucune activation runtime** (flags, policies partenaire, scheduler, Vercel, Raspberry Pi) ;
- **ne modifie aucun code / test / Prisma / Booking**.

Le squelette TBD de 012-0 §13 pour PLAN-ACQ-012-2 est **remplacé** par ce document (mapping 012-0 mis à jour en conséquence).

**DONE de cette SPEC ≠ pilote runtime activé.** L’exécution runtime, si autorisée, est une **phase distincte** hors livrable documentaire 012-2 (§14).

---

## 2. Mode autorisé

Le **seul** mode cible de 012-2 est **`AUTO_APPROVE_ONLY`**.

| `decisionCode` policy | Dans 012-2 |
|-----------------------|------------|
| `AUTO_APPROVE_ONLY` | **Cible** (si conjonction policy 012-0 §6 satisfaite **et** convert effectif OFF) |
| `HUMAN_REVIEW_REQUIRED` | **Fallback obligatoire** (policy + tout écart / kill-switch) |
| `AUTO_APPROVE_CONVERT` | **Interdit** (ne doit pas être produit par la config pilote) |

Aucun nouveau seuil, aucune nouvelle reason, aucune modification de `evaluateAutoDecision`. Source : 012-0 §6 / 012-1 §§3–4.

---

## 3. Tenant pilote

L’activation runtime **future** (phase hors 012-2 doc) doit être limitée à **un tenant pilote explicitement identifié**.

**TENANT_PILOT:** TBD

Aucun `companyId` n’est validé dans ce lot. **Ne pas inventer** de tenant.

- Aucune activation globale.
- Aucun autre tenant dans le périmètre 012-2.
- Tant que `TENANT_PILOT` = TBD : **NO-GO** activation runtime.

---

## 4. Préconditions obligatoires

Aucune de ces conditions n’est marquée **satisfaite** par 012-2 seul, sauf preuve déjà dans le dépôt (012-0 / 012-1 sur `main`).

| # | Précondition | Statut 012-2 |
|---|--------------|--------------|
| P1 | PLAN-ACQ-012-0 approuvée | **Présente** sur `main` (`0cfce21` inclut 012-0 + 012-1) |
| P2 | PLAN-ACQ-012-1 approuvée | **Présente** sur `main` (`0cfce21`) |
| P3 | Tenant pilote explicitement identifié | **TBD** (§3) |
| P4 | `SYSTEM_ACTOR` valide pour le tenant cible | **PRECONDITION** (012-0 **P-ACTOR**) |
| P5 | Partner policies explicites (tenant + partenaire cible) | **PRECONDITION** |
| P6 | Partner cible : `autoApproveEnabled === true` | **PRECONDITION** |
| P7 | Auto-convert **effectif** OFF (env ∩ partner) | **PRECONDITION** — reco 012-2 ; le code `readyForOrchestratorE2E` ne teste pas `!autoConvert` (012-0 §12.1) |
| P8 | `conversionFully` OFF | **PRECONDITION** — contrat code `readyForOrchestratorE2E` exige `!flags.conversionFully` |
| P9 | `allowCreateClient` non utilisé pour NEW | **PRECONDITION** — 012-2 interdit NEW ; EXISTING hors convert de toute façon |
| P10 | Duplicate detection (algo courant) active sur le chemin auto-decision | Mécanisme **existant** ; bornes 012-0 §4.2 : heuristique, **500** avec filtre postal, **2000** sans ; preuve ops pilote **PRECONDITION** |
| P11 | Tenant isolation validée sur chemins review/auto | Mécanismes **existants** ; preuve tenant pilote **PRECONDITION** |
| P12 | Idempotence **bornée** 012-0 §9 applicable | Mécanismes **existants** ; pas une garantie universelle de retries |
| P13 | Logs / journal exploitables | Chemins documentés ; preuve ops **PRECONDITION** |
| P14 | Rollback / kill-switch défini | **Défini documentairement** §12 ; **non exécuté** |
| P15 | Fencing **suffisant pour le périmètre exécuté** | **GAP / PRECONDITION** — **G-FENCE** (§7) |

Distinguer : capacité **code** déjà présente ≠ **GO** d’activation.

**Détection duplicate (limites figées, 012-0 §4.2) :** recherche **heuristique** ; maximum **500** candidats lorsqu’un filtre code postal est utilisé ; maximum **2000** candidats sans ce filtre ; AUTO bloqué uniquement lorsqu’un doublon est **détecté** dans ce périmètre ; **aucune** preuve globale d’absence de doublons.

---

## 5. AUTO decision contract

Reprise **stricte** de 012-0 §6 et 012-1 §§3–4. **Aucun nouveau seuil. Aucune nouvelle reason.**

Sur le chemin d’entrée **gated** (extraction ayant passé ses checks flags, puis `maybeRunAutoDecisionAfterExtraction`) :

- Env `ACQUISITION_AUTO_APPROVE_ENABLED === "true"`
- Partner actif résolu + `autoApproveEnabled === true`
- `resolveValidatedSystemActor` OK pour le **tenant cible**
- Draft `PENDING_REVIEW`
- Lectures scopées `companyId`
- Données / confiance / warnings / duplicate **détecté** / ambiguïté / injection / documents selon policy

⇒ si convert effectif OFF et seuils OK : **`AUTO_APPROVE_ONLY`**.
⇒ sinon policy : **`HUMAN_REVIEW_REQUIRED`**.

**Master :** typiquement ON sur le chemin extraction gated ; **pas** un check interne de `maybeRunAutoDecisionAfterExtraction` (**G-MASTER-SERVICE-SCOPE**). Voir §8.

Vocabulaire inchangé (decisionCode vs reasons vs logs vs skip reasons) : 012-0 §6.5 / 012-1 §4.2.

---

## 6. Conversion interdite

Pour **toute** la durée du pilote 012-2 (y compris une phase runtime ultérieure autorisée) :

| Interdiction | Sens |
|--------------|------|
| `ACQUISITION_AUTO_CONVERT_ENABLED` | **Ne doit pas** être used/`true` pour le pilote |
| Partner `autoConvertEnabled` | **OFF** pour le partenaire cible |
| Transition auto vers `CONVERTED` | **Interdite** |
| Création chantier automatique | **Interdite** |
| Client **NEW** automatique | **Interdit** |
| `AUTO_APPROVE_CONVERT` | Config pilote ne doit **pas** le produire |

Le code **peut** encore contenir le chemin convert (Lot F). 012-2 **n’utilise pas** ce chemin. Ne pas confondre capacité code et autorisation du lot.

`allowCreateClient` n’est **pas** une précondition de conversion EXISTING (012-0 F7) ; en 012-2 il n’y a **aucune** conversion, EXISTING ou NEW.

---

## 7. Fencing

Source : 012-0 §11 ; `docs/acquisition-ops-v2-fencing-workers.md` ; **G-FENCE**.

### 7.1 Chemin worker du pilote

Auto-approve s’exécute **après extraction** (`maybeRunAutoDecisionAfterExtraction` depuis `extraction.service.ts`).

Chemin orchestrateur nominatif :

`gmailSync` → `attachmentRecovery` → `attachmentDownload` → `contentFetch` → **`extraction`** → (hook auto-decision + `approveImportDraft` si AUTO)

| Étape | Heartbeat mid-run (`shouldContinue` / `renew`) | Fence inter-étapes `assertOwned` |
|-------|-----------------------------------------------|----------------------------------|
| `gmailSync` | **Oui** | Oui |
| `attachmentRecovery` / `download` / `contentFetch` | **Non** | Oui (entre steps) |
| `extraction` | **Non** | Oui (entre steps) |

Lease orchestrateur + budget enfant clampé : **existants**. Heartbeat mid-run **extraction** : **incomplet**.

### 7.2 Suffisance pour le pilote

012-0 §11.2 : GO auto/convert **large** ou traitements **longs** prod seulement si fencing mid-worker non-Gmail **ou** preuve `maxDurationMs` **strictement** &lt; TTL lease + marge.

Cette preuve **n’est pas** fournie par 012-2. **G-FENCE** reste ouvert.

| Niveau | Fencing | Décision |
|--------|---------|----------|
| Activation auto **large** / traitements longs | Non prouvée | **NO-GO** |
| Pilote borné (tenant unique, durée worker extraite **prouvée** &lt; TTL+marge) | Non encore prouvée | **PRECONDITION** |
| Absence de preuve `maxDurationMs` vs TTL | — | **NO-GO** runtime jusqu’à preuve ou fencing |

012-2 **ne code pas** le fencing (**PLAN-ACQ-V2-FENCING-WORKERS** / 012-0 mapping 012-4 restent hors scope).

---

## 8. Master scope

**G-MASTER-SERVICE-SCOPE** conservé (012-0 §4.1).

- `PLANIFICATOR_ACQUISITION_ENABLED` = kill-switch des **entrées / gates explicitement gated**.
- `registerIncomingMessage()` **ne** vérifie **pas** le master en interne.
- `maybeRunAutoDecisionAfterExtraction()` gate sur `ACQUISITION_AUTO_APPROVE_ENABLED`, **pas** le master.

Toute phase runtime future du pilote **doit** utiliser uniquement les chemins gated documentés (cron/orchestrateur → extraction gated → auto-decision). **Pas** d’appel direct de services internes hors ces chemins.

---

## 9. Staging avant pilote

Preuves **minimales à obtenir** avant toute phase runtime tenant pilote. **Aucune n’est déclarée déjà obtenue** par 012-2.

| Preuve | Exigence |
|--------|----------|
| E2E staging vert | Jusqu’au niveau ciblé (au minimum extraction → décision journalisée) sur **staging**, tenant de test identifié — **pas** le TENANT_PILOT TBD |
| Journal décision visible | `decisionCode` + `reasons` lisibles (012-0 journal) |
| `AUTO_APPROVE_ONLY` observable | Config staging **temporaire** dédiée preuve — **hors** activation production ; convert OFF |
| `HUMAN_REVIEW_REQUIRED` observable | Cas policy (partner OFF, low confidence, duplicate détecté, etc.) |
| Aucune conversion automatique | Aucun draft `CONVERTED` par auto-decision |
| Aucune mutation Booking | Pipelines disjoints (012-0 §10) |
| Cursor | Pas d’avancement `lastHistoryId` de succès sur SKIPPED / PARTIAL / FAILED (012-0 §9) ; SKIPPED ≠ zéro écriture technique |
| Retries | Bornés aux garanties 012-0 §9 — **pas** « retries cron sûrs » universels |

`readyForOrchestratorE2E` (contrat **code**) exige notamment `!flags.autoApprove` et `!flags.conversionFully` (012-0 §12.1). Une preuve staging `AUTO_APPROVE_ONLY` implique donc un **écart volontaire** vis-à-vis de ce ready-flag Lot C : documenter l’env de preuve, **ne pas** le confondre avec `readyForOrchestratorE2E === true`. Reco ops : `autoConvert` OFF (012-0 §12.2) — **recommandation**, pas invariant du calcul code.

---

## 10. Tests d’acceptation

**À exiger** pour une phase runtime (ou lot d’implémentation tests) — **non codés** par 012-2.

Ancrages existants (non exhaustifs, 012-0 §14) : `auto-decision.policy.test.ts`, `auto-decision.service.test.ts`, `acquisition-flag-matrix.test.ts`, suites review / eligibility / booking.

| Thème | Exigence |
|-------|----------|
| Partner `autoApprove` ON | Décision AUTO possible si reste de la conjonction OK |
| Partner `autoApprove` OFF | `HUMAN_REVIEW_REQUIRED` + reason `AUTO_APPROVE_DISABLED` |
| Env autoApprove OFF | Early return ; aucun approve via ce chemin |
| System actor invalid / missing | Pas d’approve ; journal `decisionCode` `SYSTEM_ACTOR_INVALID` ; `SYSTEM_ACTOR_MISSING` possible en **reasons** |
| Tenant mismatch actor | Idem `tenant_mismatch` |
| `HUMAN_REVIEW_REQUIRED` | Reasons 012-0 §6.3 |
| `AUTO_APPROVE_ONLY` | Seuils OK + convert effectif OFF |
| Auto-convert OFF | Pas de `AUTO_APPROVE_CONVERT` ; pas d’appel convert réussi |
| `conversionFully` OFF | Conversion métier fully non utilisée |
| Client NEW interdit | Aucun NEW auto (012-2 : aucune conversion) |
| Client EXISTING | Inchangé par 012-2 (pas de convert) |
| Duplicate **détecté** | REVIEW (`POTENTIAL_DUPLICATE`) dans le périmètre heuristique (500 avec postal / 2000 sans) — pas une preuve d’absence globale |
| Low confidence | `LOW_CONFIDENCE:*` → REVIEW |
| Prompt injection | `PROMPT_INJECTION_RISK` → REVIEW |
| Document requis illisible | `REQUIRED_DOCUMENT_UNREADABLE` → REVIEW |
| Booking / gmail-scan | Non-régression ; pas d’import Acquisition → Booking |
| Kill-switch | Master OFF sur **entrées gated** ; autoApprove env OFF |
| Rollback | Procédure §12 documentée ; pas exécutée ici |

---

## 11. GO / NO-GO

Checklist **documentaire** du lot 012-2.
**GO** = preuve pour **ce** lot de gouvernance (pas « ready to activate in prod »).
Ne pas marquer **GO** sans preuve.

| ITEM | STATUS | EVIDENCE | BLOCKS_PILOT |
|------|--------|----------|--------------|
| SPEC 012-0 sur `main` | **GO** | `0cfce21` | NO |
| SPEC 012-1 sur `main` | **GO** | `0cfce21` | NO |
| Contrat `AUTO_APPROVE_ONLY` figé | **PRECONDITION** | Défini dans cette SPEC §§2, 5 ; acquis à l’approbation de PLAN-ACQ-012-2 — **pas** runtime ready | YES runtime tant que 012-2 non approuvée ; NO pour DONE SPEC une fois approuvée |
| TENANT_PILOT identifié | **TBD** | Aucun tenant validé | **YES** (runtime) |
| SYSTEM_ACTOR valide tenant cible | **PRECONDITION** | **P-ACTOR** | **YES** (runtime AUTO) |
| Partner policies explicites + autoApprove ON partenaire cible | **PRECONDITION** | Ops / admin | **YES** (runtime) |
| Auto-convert effectif OFF | **PRECONDITION** | Env ∩ partner ; ≠ champ `readyForOrchestratorE2E` | **YES** (runtime 012-2) |
| `conversionFully` OFF | **PRECONDITION** | 012-0 §12.1 | **YES** si ON (sortie du contrat Lot C / risque convert métier) |
| NEW client / convert / chantier auto | **NO-GO** | §6 / §13 | **YES** si tenté |
| Duplicate heuristique + idempotence bornée | **PRECONDITION** | 012-0 §§4.2, 9 | **YES** si mécanismes contournés |
| Fencing périmètre exécuté | **GAP** | **G-FENCE** ; §7 | **YES** large / longs ; **YES** pilote tant que `maxDuration` vs TTL non prouvé |
| Staging preuves §9 | **PRECONDITION** | Non collectées par 012-2 | **YES** (runtime) |
| Rollback défini | **GO** | §12 documentaire | NO pour DONE SPEC |
| Booking isolation | **GO** | 012-0 §10 ; 012-2 n’y touche pas | **YES** si violation |
| `INV_*` comme kill-switch | **NO-GO** / **GAP** | **G-INV** | Ne pas s’y fier |
| Activation runtime dans le lot 012-2 (doc) | **NO-GO** | §1 / §14 | **YES** si effectuée sous ce ticket doc |
| Master via services internes non gated | **GAP** | **G-MASTER-SERVICE-SCOPE** | **YES** si appels directs |

---

## 12. Rollback

**Documentaire uniquement** — ne pas exécuter dans 012-2.

1. `ACQUISITION_AUTO_APPROVE_ENABLED` → OFF (et/ou partner `autoApproveEnabled` → false sur le partenaire cible).
2. Conserver `ACQUISITION_AUTO_CONVERT_ENABLED` OFF et partner `autoConvertEnabled` OFF.
3. Reprise du fallback **`HUMAN_REVIEW_REQUIRED`** (policy si approve effectif false ; drafts déjà `APPROVED` par auto **ne sont pas** « dés-approuvés » automatiquement par ce rollback flags).
4. Ne pas modifier Booking / gmail-scan / cursors Booking.
5. Ne pas supprimer les lignes déjà journalisées (`acquisition_decision_journals` / logs).
6. Master OFF sur **entrées gated** si kill-switch plus large nécessaire (012-0 F2 borné).

Limite : le rollback **flags** arrête de **nouveaux** auto-approves via le chemin service ; il ne revert pas l’historique métier déjà persisté.

---

## 13. Hors scope

- `AUTO_APPROVE_CONVERT` / auto-convert ;
- création automatique de chantier / `CONVERTED` ;
- client **NEW** automatique ;
- Booking / `/api/cron/gmail-scan` ;
- Prisma / migrations ;
- OAuth / Gmail parser / mapper ;
- scheduler Raspberry Pi / Vercel / production rollout **global** ;
- autres tenants que le pilote (quand identifié) ;
- fermeture **G-FENCE** / **G-INV** / **G-RB** (sauf preuve `maxDuration` optionnelle, hors code 012-2) ;
- PLAN-ACQ-012-3+ (auto-convert, fencing lot, runbook OPS-007, etc.).

---

## 14. Critère de sortie

**PLAN-ACQ-012-2 (SPEC) est DONE lorsque :**

1. ce document est **approuvé** ;
2. le **contrat** tenant pilote + préconditions est **explicitement défini** (le tenant lui-même peut rester **TBD** : DONE SPEC **n’exige pas** l’affectation du `companyId`) ;
3. la checklist GO / NO-GO §11 est **complète** ;
4. les tests d’acceptation §10 sont **définis** (non nécessairement exécutés / ajoutés dans ce lot) ;
5. le rollback §12 est **défini** ;
6. **aucune** activation runtime n’a eu lieu dans le cadre de 012-2 ;
7. **aucun** code métier, Booking, Prisma, scheduler n’a été modifié.

DONE SPEC **ne signifie pas** :

- que le pilote runtime est activé ;
- que `TENANT_PILOT` est choisi ;
- que G-FENCE / P-ACTOR / preuves staging sont clos ;
- que l’auto est prête en production.

**Phase runtime (hors DONE 012-2) :** activation flags/policies sur un tenant identifié, uniquement après GO des PRECONDITION/GAP §11, ticket/autorisation **séparé** (non 012-3+ sauf SPEC dédiée).

---

## 15. Relation avec 012-0 / 012-1 / 012-3+

- 012-0 / 012-1 restent la source des critères AUTO/REVIEW et garde-fous.
- Toute divergence de seuils / reasons ⇒ amendement **012-0**, pas une règle 012-2 concurrente.
- 012-3+ **hors scope** ; non définis par ce document.

---

## Historique

| Date | Note |
|------|------|
| 2026-08-15 | Création SPEC 012-2 suite audit `012_2_SCOPE_NOT_DEFINED` ; encadrement pilote `AUTO_APPROVE_ONLY` sans activation runtime |
