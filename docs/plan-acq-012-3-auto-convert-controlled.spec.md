# PLAN-ACQ-012-3 — Controlled Auto-Convert

| Champ | Valeur |
|-------|--------|
| **Ticket** | PLAN-ACQ-012-3 |
| **Type** | SPEC normative d’encadrement d’un futur pilote `AUTO_APPROVE_CONVERT` (documentation seule) |
| **Statut** | DRAFT — prêt pour revue |
| **HEAD de référence** | `aac419046ccd08dd441fa0b737eec464aae359ae` |
| **Sources normatives** | `docs/plan-acq-012-0-auto-review-guardrails.spec.md`, `docs/plan-acq-012-1-auto-review-adoption.spec.md`, `docs/plan-acq-012-2-auto-approve-pilot.spec.md` |
| **Implémentation métier** | **Interdite** dans ce lot |
| **Activation runtime** | **Interdite** dans ce lot |

---

## 1. Rôle

PLAN-ACQ-012-3 **encadre** un **futur** mode :

**`AUTO_APPROVE_CONVERT`**

après satisfaction **explicite** des préconditions issues de PLAN-ACQ-012-2 (et 012-0 / 012-1).

Ce lot :

- **n’active rien** (flags, policies partenaire, scheduler, Vercel, Raspberry Pi) ;
- **n’élargit pas automatiquement** le pilote 012-2 (mode 012-2 reste `AUTO_APPROVE_ONLY` / convert OFF jusqu’à une phase runtime **séparée** explicitement autorisée) ;
- **ne modifie aucun** code / test / Prisma / matching / policy / Booking.

Toute activation runtime auto-convert, si un jour autorisée, est une **phase distincte** hors DONE de cette SPEC (§16).

---

## 2. Dépendance à 012-2

| Niveau | Sens | Preuve actuelle |
|--------|------|-----------------|
| **SPEC 012-2 approuvée** | Contrat `AUTO_APPROVE_ONLY` documenté sur `main` | **Oui** — HEAD `aac4190` |
| **Pilote runtime 012-2 exécuté / validé** | Flags/policies auto-approve only sur tenant identifié, preuves §9 de 012-2 | **Non** — 012-2 interdit l’activation dans le lot SPEC ; DONE 012-2 ≠ pilote runtime |

**012-3 ne peut être envisagé** (comme encadrement) que si la **SPEC** 012-2 est approuvée.

**Phase runtime auto-convert :** le pilote runtime 012-2 **exécuté et validé** (preuves 012-2 §9 : journal `AUTO_APPROVE_ONLY` / `HUMAN_REVIEW_REQUIRED`, pas de convert auto, Booking intact, fencing/TTL) est une **PRECONDITION** / **NO-GO** tant que non obtenue.

Cette SPEC **n’invente pas** cette preuve.

---

## 3. Mode cible

Le **seul** mode cible éventuel de 012-3 est **`AUTO_APPROVE_CONVERT`**.

| `decisionCode` policy | Dans 012-3 |
|-----------------------|------------|
| `AUTO_APPROVE_CONVERT` | **Cible** (conjonction 012-0 §6 **et** convert effectif ON **et** conversion fully) |
| `HUMAN_REVIEW_REQUIRED` | **Fallback obligatoire** |
| `AUTO_APPROVE_ONLY` | Hors cible 012-3 (c’est le mode 012-2) ; si produit, **aucune** conversion (code : return après approve) |

Aucun nouveau seuil, aucune nouvelle reason, aucune modification de `evaluateAutoDecision`. Source : 012-0 §6 / 012-1 §§3–4.

---

## 4. Préconditions obligatoires

Aucune condition runtime n’est **GO** sans preuve. Specs sur `main` ≠ activation.

| # | Précondition | Statut 012-3 |
|---|--------------|--------------|
| P1 | PLAN-ACQ-012-0 approuvée | **Présente** `main` (`aac4190`) |
| P2 | PLAN-ACQ-012-1 approuvée | **Présente** `main` |
| P3 | PLAN-ACQ-012-2 **SPEC** approuvée | **Présente** `main` |
| P4 | Périmètre 012-2 **runtime** validé (si requis avant auto-convert) | **PRECONDITION / NO-GO** — non exécuté (012-2) |
| P5 | Tenant cible explicitement identifié | **TBD** — aucun `companyId` inventé |
| P6 | `SYSTEM_ACTOR` valide pour le tenant cible | **PRECONDITION** (**P-ACTOR**) |
| P7 | Partner policies explicites | **PRECONDITION** |
| P8 | Partner `autoApproveEnabled` + env auto-approve ON | **PRECONDITION** |
| P9 | Auto-convert **explicitement** autorisé (env ∩ partner) | **PRECONDITION** |
| P10 | `conversionFully` effective (master ∩ `ACQUISITION_CONVERSION_ENABLED`) | **PRECONDITION** — requis par `convertImportDraft` |
| P11 | Duplicate detection (algo courant) opérationnelle | Mécanisme **existant** ; preuve ops **PRECONDITION** |
| P12 | Tenant isolation chemins review/convert | Mécanismes **existants** ; preuve tenant **PRECONDITION** |
| P13 | Idempotence conversion bornée (§10) | Mécanismes **existants** ; pas « retry safe » universel |
| P14 | Fencing / concurrence sur **tous** les chemins d’extraction activés (cron/orchestrateur **et** UI) | **GAP / PRECONDITION / NO-GO** — **G-FENCE** (§11) ; lease orchestrateur **non** globale |
| P15 | Logs / journal exploitables | Chemins documentés ; preuve ops **PRECONDITION** |
| P16 | Rollback défini | **Défini documentairement** §14 ; **non exécuté** |
| P17 | Booking isolation | Règle figée 012-0 §10 ; 012-3 n’y touche pas |

---

## 5. Conversion contract (comportement code réel)

Sources : `src/lib/acquisition/conversion/conversion.service.ts`, `conversion-feature-flag.ts`, `auto-decision.service.ts`.
**Aucune** garantie plus forte que ce code.

| Étape | Comportement prouvé |
|-------|---------------------|
| Gate conversion | `isAcquisitionConversionFullyEnabled()` sinon `CONVERSION_DISABLED` |
| AuthZ | Rôles ADMIN/SUPER_ADMIN **ou** `actorRole === "SYSTEM"` |
| Lookup | `findFirst({ id: draftId, companyId })` |
| Déjà converti (hors TX) | `status === "CONVERTED"` + `createdWorksiteId` → **`ALREADY_CONVERTED`** |
| État préalable | Sinon **`APPROVED`** requis ; autre statut → `INVALID_STATE` |
| Introuvable | `NOT_FOUND` |
| Transaction | Une `$transaction` interactive |
| Claim version | `draft.version === expectedVersion` sinon `ConversionClaimConflictError` |
| Claim final | `updateMany` `APPROVED` + version attendue → `CONVERTED` + `version++` ; `count !== 1` → conflit |
| Conflit | Remap `resolveAlreadyConverted` (souvent `ALREADY_CONVERTED` ou `STATE_CHANGED`) |
| Doublon en TX | `findDuplicateWorksite` ; si hit et (`SYSTEM` **ou** `!acknowledgeDuplicateWorksite`) → `DUPLICATE_REQUIRES_ACK` — **SYSTEM ne peut pas ack** |
| Client EXISTING | `client.findFirst` même `companyId` ; sinon `CLIENT_NOT_FOUND` |
| Client NEW | `client.create` dans la TX (auto-decision n’appelle ce mode que si `allowCreateClient` — §7) |
| Chantier + documents | Création worksite + documents depuis PJ `STORED` avec `storagePublicId` ; autres PJ skip |
| Journal conversion | Logs `[acquisition-conversion]` `CONVERT_OK` / `CONVERT_CONFLICT` / `CONVERT_INTERNAL_ERROR` |
| Journal auto-decision | Premier append = `decisionCode` policy ; convert : log `AUTO_CONVERT_RESULT` (ok/outcome/code) — **pas** un second `decisionCode` policy de succès convert |
| Géocodage | Post-TX, hors succès bloquant (`void applyGeocodeAfterConvert`) |

Auto-decision **n’appelle** `convertImportDraft` que si `decision.code === "AUTO_APPROVE_CONVERT"` **après** approve OK, actor OK, skip NEW/duplicate.

Échec convert après approve : le draft peut rester **`APPROVED`** sans `CONVERTED` (log `AUTO_CONVERT_RESULT` / skip). Ce n’est **pas** un rollback auto vers `PENDING_REVIEW`.

---

## 6. Client EXISTING

Si `matchClientForDraft` résout un `clientId` **non ambigu** :

- auto-convert (quand autorisé) utilise `clientMode: "EXISTING"` ;
- **`allowCreateClient` n’est pas** une précondition de ce chemin (012-0 F7).

012-3 **ne modifie pas** le matching.

---

## 7. Client NEW

Règle **code** auto-decision (non réinventée) : si `clientMatch.clientId == null`, NEW seulement si **toutes** :

- `allowCreateClient === true` (partner) ;
- **pas** `clientMatch.ambiguous` ;
- identité proposée (nom ou email) ;
- nom NEW non vide après trim.

Sinon : log `AUTO_CONVERT_SKIPPED_NO_CLIENT` / `AUTO_CONVERT_SKIPPED_NO_CLIENT_NAME` ; **pas** d’appel convert NEW.

`allowCreateClient` OFF ⇒ **aucun** NEW automatique.

---

## 8. Duplicate detection

Limites **figées** 012-0 §4.2 / `findDuplicateWorksite` :

- recherche **heuristique** (clé d’adresse normalisée, chantiers `PLANNED` / `IN_PROGRESS` / `EXTENDED` du **même** `companyId`) ;
- **bornée** : **500** candidats si filtre code postal ; **2000** sans ce filtre ;
- si un doublon est **détecté dans ce périmètre** :
  - policy : `POTENTIAL_DUPLICATE` → `HUMAN_REVIEW_REQUIRED` (donc **pas** d’approve/convert auto, §9) ;
  - auto-decision : double-check `AUTO_CONVERT_BLOCKED_DUPLICATE` ;
  - convert SYSTEM : `DUPLICATE_REQUIRES_ACK` (pas d’ack SYSTEM) ;
- **aucune** preuve globale d’absence de doublon hors ce périmètre.

Ne pas écrire « aucun doublon » sans qualifier **détecté par l’algorithme courant**.

---

## 9. Review non contournable

Code `maybeRunAutoDecisionAfterExtraction` :

```
if (decision.code === "HUMAN_REVIEW_REQUIRED") return
```

**avant** resolve actor approve / convert.

Si la policy retourne **`HUMAN_REVIEW_REQUIRED`** :

- **aucun** `approveImportDraft` automatique ;
- **aucune** conversion automatique.

`AUTO_APPROVE_ONLY` : approve possible puis `if (decision.code !== "AUTO_APPROVE_CONVERT") return` — **pas** de convert.

Cette affirmation correspond au code actuel. 012-3 **n’autorise pas** de bypass.

---

## 10. Idempotence conversion — garanties bornées

**Ne pas** affirmer « conversion retry safe » universel.

| MÉCANISME | GARANTIE PROUVÉE | LIMITE |
|-----------|------------------|--------|
| Early `ALREADY_CONVERTED` | Reprise si déjà `CONVERTED` + worksite | Ne recrée pas chantier/client sur ce chemin |
| Claim `expectedVersion` dans TX | Mauvaise version → conflit | Optimistic concurrency, pas idempotence de **tous** les side-effects |
| `updateMany` claim `APPROVED`+version | Un seul winner | Autre concurrent → conflit + remap |
| Remap conflit | `resolveAlreadyConverted` | Peut retourner `ALREADY_CONVERTED` **ou** `STATE_CHANGED` si pas encore converti |
| Retry conversion | Safe **si** déjà `CONVERTED` (early/remap) | Retry sur `APPROVED` encore ouvert peut **rejouer** convert (un seul claim gagne) — pas « always no-op » |
| Créations liées (client NEW, worksite, documents) | Dans la **même** TX que le claim | Rollback TX si claim échoue ; géocode **hors** TX, non couvert |
| Auto-decision duplicate/NEW skip | Pas d’appel convert | Draft peut rester `APPROVED` après approve |

---

## 11. Fencing

**G-FENCE** ouvert (012-0 §11 ; 012-2 §7). **Aucun heartbeat mid-run sur l’extraction.** 012-3 **ne code pas** de solution.

### 11.1 Déclenchement réel de l’auto-decision

`maybeRunAutoDecisionAfterExtraction` est appelé **après extraction réussie** depuis `runDraftExtractionCore` (`extraction.service.ts`).

Ce core peut être appelé depuis **au moins deux** classes de chemins :

| PATH | ORCHESTRATOR_LEASE | Heartbeat extraction | FENCING_STATUS | AUTO-CONVERT |
|------|--------------------|----------------------|----------------|--------------|
| Cron / orchestrateur → `runDraftExtractionSystem` → `runDraftExtractionCore` → `maybeRunAutoDecisionAfterExtraction` | Possible (lease step `extraction` : `assertOwned` **entre** steps ; **pas** de `renew` / `shouldContinue` pendant l’extraction) | **NON** | **NOT PROVEN / G-FENCE** | **NO-GO** sans preuve de concurrence sur **tous** les chemins activés |
| UI extraction → `runDraftExtraction` → `runDraftExtractionCore` → `maybeRunAutoDecisionAfterExtraction` | **NO** | **NON** | **NOT PROVEN / G-FENCE** | **NO-GO** sans preuve de concurrence sur **tous** les chemins activés |

La lease orchestrateur **seule** n’est **pas** une garantie globale de fencing pour l’auto-decision (le chemin UI n’y est pas couvert ; le worker extraction n’a pas de heartbeat mid-run).

Autres steps orchestrateur (rappel, inchangé) : `gmailSync` a heartbeat ; recovery / download / content **non**.

### 11.2 Conséquence pour une future activation

Une future phase runtime `AUTO_APPROVE_CONVERT` doit **prouver** le contrôle de concurrence pour **tous** les chemins d’extraction réellement activés (cron/orchestrateur **et** UI, s’ils restent joignables).

En l’absence de cette preuve : **PRECONDITION / NO-GO**.

| Niveau | Décision |
|--------|----------|
| Auto-convert **large** / traitements longs | **NO-GO** |
| Un seul chemin « sous lease » sans traiter l’UI | **NO-GO** |
| Sans preuve durée/`maxDurationMs` vs TTL **et** sans restriction des chemins UI | **NO-GO** runtime |
| Preuve concurrence **tous chemins** **ou** fencing dédié (hors 012-3) | **PRECONDITION** |

012-4+ / `PLAN-ACQ-V2-FENCING-WORKERS` restent hors scope.

---

## 12. GO / NO-GO

**GO** = preuve pour **ce** lot documentaire, **pas** « auto-convert ready prod ».

| ITEM | STATUS | EVIDENCE | BLOCKS_AUTO_CONVERT |
|------|--------|----------|---------------------|
| SPEC 012-0 / 012-1 / 012-2 sur `main` | **GO** | `aac4190` | NO (DONE SPEC 012-3) |
| Contrat `AUTO_APPROVE_CONVERT` figé | **PRECONDITION** | §§3–9 de ce document ; acquis à l’**approbation** 012-3 — pas runtime ready | YES runtime tant que 012-3 non approuvée |
| Pilote runtime 012-2 validé | **PRECONDITION** / **NO-GO** | Non exécuté | **YES** |
| Tenant cible identifié | **TBD** | Aucun tenant validé | **YES** |
| SYSTEM_ACTOR tenant cible | **PRECONDITION** | **P-ACTOR** | **YES** |
| Partner policy + autoApprove ON | **PRECONDITION** | Ops | **YES** |
| Auto-convert env ∩ partner ON | **PRECONDITION** | Opposé au cadre 012-2 | **YES** |
| `conversionFully` ON | **PRECONDITION** | Flag conversion.service | **YES** si OFF |
| Chemin EXISTING | Mécanisme existant | Code §6 | Preuve ops **PRECONDITION** |
| Chemin NEW / `allowCreateClient` | **PRECONDITION** | ON seulement si NEW voulu ; OFF = pas de NEW | **YES** si NEW sans flag |
| Duplicate heuristique 500/2000 | **PRECONDITION** | 012-0 §4.2 | **YES** si contournée |
| Idempotence convert bornée | **PRECONDITION** | §10 | **YES** si garantie universelle postulée |
| Fencing extraction (orchestrateur **et** UI) | **GAP** | **G-FENCE** ; §11 — lease seule insuffisante | **YES** large / sans preuve concurrence **tous chemins** |
| Logs / journal | **PRECONDITION** | Preuve ops manquante | **YES** runtime |
| Rollback défini | **GO** | §14 documentaire | NO pour DONE SPEC |
| Booking isolation | **GO** | 012-0 §10 ; 012-3 n’y touche pas | **YES** si violation |
| `INV_*` kill-switch | **NO-GO** / **GAP** | **G-INV** | Ne pas s’y fier |
| Activation runtime dans le lot 012-3 | **NO-GO** | §1 / §16 | **YES** si effectuée |
| Master via services non gated | **GAP** | **G-MASTER-SERVICE-SCOPE** | **YES** si appels directs |
| Bypass `HUMAN_REVIEW_REQUIRED` | **NO-GO** | §9 / code | **YES** |

---

## 13. Tests d’acceptation

**Définis, non codés** dans 012-3. Ancrages existants possibles : `auto-decision.service.test.ts`, `conversion.service.test.ts`, `conversion.integration.test.ts`.

| Thème | Exigence |
|-------|----------|
| `HUMAN_REVIEW_REQUIRED` | Aucun approve auto ; aucune conversion |
| `AUTO_APPROVE_ONLY` | Approve possible ; **aucune** conversion |
| `AUTO_APPROVE_CONVERT` | Tentative convert **autorisée** par décision (si reste des gates OK) |
| Partner autoConvert OFF | Pas `AUTO_APPROVE_CONVERT` ; pas convert |
| Env autoConvert OFF | Idem |
| `conversionFully` OFF | `CONVERSION_DISABLED` / pas convert métier |
| SYSTEM_ACTOR invalide / missing | Pas d’approve ; pas de convert ; `decisionCode` journal `SYSTEM_ACTOR_INVALID` |
| Tenant mismatch | Idem `tenant_mismatch` |
| Duplicate **détecté** (périmètre 500/2000) | REVIEW et/ou pas convert SYSTEM |
| Client EXISTING | Convert EXISTING sans `allowCreateClient` |
| NEW + `allowCreateClient` ON | NEW possible si identité claire / non ambigu |
| NEW + `allowCreateClient` OFF | Skip NEW ; pas de create client |
| `ALREADY_CONVERTED` | Reprise sans second chantier |
| Concurrence version | Claim / `STATE_CHANGED` / remap |
| Retry borné | Selon table §10 — **TBD** preuve runtime pilote |
| Booking / gmail-scan | Non-régression |
| Kill-switch | Master gated ; flags auto/convert OFF |
| Rollback | Procédure §14 — **TBD** exécution ops |

Preuves **impossibles sans runtime / staging dédié** : journal live tenant pilote, fencing durée réelle vs TTL, rollback ops réel → **TBD**.

---

## 14. Rollback

**Documentaire uniquement** — ne pas exécuter dans 012-3. **Non destructif.**

1. `ACQUISITION_AUTO_CONVERT_ENABLED` → OFF (et/ou partner `autoConvertEnabled` → false).
2. `autoApprove` : **peut** rester ON (retour de facto `AUTO_APPROVE_ONLY` si convert effectif OFF) **ou** passer OFF — **décision opératoire à documenter au moment de l’exécution** ; cette SPEC n’impose pas de détruire l’approve.
3. Fallback policy : **`HUMAN_REVIEW_REQUIRED`** si approve effectif false ; si approve ON et convert OFF → `AUTO_APPROVE_ONLY`.
4. **Ne pas** supprimer le journal.
5. **Ne pas** supprimer drafts/chantiers/clients **déjà convertis**.
6. **Aucun** impact Booking / gmail-scan.

Le rollback **n’annule pas** un `CONVERTED` déjà persisté.

---

## 15. Hors scope

- activation runtime / rollout production global ;
- modification `conversion.service` / matching / policy / seuils ;
- Prisma / migrations ;
- Booking / `/api/cron/gmail-scan` ;
- Vercel / Raspberry Pi / scheduler ;
- fermeture code **G-FENCE** / **G-INV** / **G-RB** ;
- PLAN-ACQ-012-4+.

---

## 16. Critère de sortie

**PLAN-ACQ-012-3 SPEC est DONE lorsque :**

1. ce document est **approuvé** ;
2. le contrat `AUTO_APPROVE_CONVERT` est **figé** sans divergence 012-0/012-1 ;
3. les préconditions sont **classées** (§4 / §12) ;
4. la checklist GO/NO-GO est **complète** ;
5. les tests d’acceptation sont **définis** (non nécessairement ajoutés/exécutés ici) ;
6. le rollback est **défini** ;
7. les gaps (**G-FENCE**, **G-INV**, **G-MASTER-SERVICE-SCOPE**, pilote 012-2 runtime, tenant TBD) sont **explicites** ;
8. **aucune** activation runtime n’a eu lieu dans 012-3 ;
9. **aucun** code métier n’a été modifié.

DONE SPEC **≠** auto-convert activé, **≠** production ready, **≠** TENANT choisi, **≠** pilote 012-2 runtime clos.

**Phase runtime (hors DONE 012-3) :** ticket/autorisation **séparé**, après GO des PRECONDITION/GAP §12. Non assimilé à 012-4+ sauf SPEC dédiée.

---

## 17. Relation 012-0 / 012-1 / 012-2 / 012-4+

- 012-0 / 012-1 : source AUTO/REVIEW.
- 012-2 : convert **interdit** jusqu’à phase runtime **post-012-3** autorisée.
- 012-4+ : hors scope (fencing, runbook flags, etc.).

---

## Historique

| Date | Note |
|------|------|
| 2026-08-15 | Création SPEC 012-3 suite audit `012_3_SCOPE_NOT_DEFINED` ; encadrement `AUTO_APPROVE_CONVERT` sans activation runtime |
