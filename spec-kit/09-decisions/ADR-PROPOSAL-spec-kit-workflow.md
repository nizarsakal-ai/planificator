# ADR-PLAN-??? (PROPOSITION) — Spec Kit : emplacement, statut et workflow étendu

> Audience : Autorité Architecture, contributeurs · Statut : **Proposé** (brouillon, ne fait pas foi)

| Champ | Valeur |
|-------|--------|
| **Statut** | **Proposé** — ne fait pas foi tant que l'Autorité Architecture ne l'a pas accepté |
| **Numéro** | À attribuer à l'acceptation (`docs/adr/` est vide : ce serait `ADR-PLAN-001`) ; fichier final `docs/adr/ADR-PLAN-001-spec-kit-workflow.md` |
| **Date** | 2026-10-07 |

## 1. Contexte

- ES-001 §20.3 exige que chaque dépôt définisse où vivent constitution, ADR, specs, runbooks, architecture. Aujourd'hui : constitution dans `docs/constitution/`, ADR dans `docs/adr/`, specs dans `docs/`. Le Spec Kit (`spec-kit/` à la racine, choix de l'utilisateur) n'a **pas de niveau** dans la hiérarchie ES-001 → PLAN-GOVERNANCE-001 → ADR → SPEC → TASK.
- PLAN-GOVERNANCE-001 impose : ARCHITECTURE → SPECIFICATION → IMPLEMENTATION → INDEPENDENT REVIEW → CORRECTIONS → VALIDATION → GIT → PULL REQUEST → MERGE → PRODUCTION READINESS REVIEW → MODULE CLOSED. Il ne décrit pas l'audit en lecture seule préalable, le staging, l'autorisation utilisateur avant production ni les preuves de smoke test.
- ES-001 §25.1 et §25.4 : **PRR avant la première mise en production** d'un module critique ; une PRR allégée n'est permise que « si définie par le projet ».
- Le système de délégation multi-agents impose que l'implémenteur ne soit jamais son propre reviewer indépendant et qu'aucun agent n'autorise seul un merge ou une écriture en production (déjà dans l'annexe de PLAN-GOVERNANCE-001).

## 2. Décision proposée

1. **Statut du kit** : « complément opérationnel » de la gouvernance (niveau transverse, sous ES-001 et PLAN-GOVERNANCE-001, qui prévalent). Emplacement : **`spec-kit/` à la racine**. Il **renvoie** à `docs/constitution/`, `docs/adr/` et aux specs de `docs/` sans les dupliquer.
2. **Workflow étendu** (aucune étape de PLAN-GOVERNANCE-001 supprimée) :
   BESOIN → AUDIT READ-ONLY → ARCHITECTURE / ADR → SPECIFICATION → VALIDATION DU PÉRIMÈTRE → IMPLÉMENTATION → TESTS → REVUE INDÉPENDANTE → CORRECTIONS → VALIDATION (preuves) → GIT → PR → MERGE → STAGING → VALIDATION STAGING → **PRR (GO)** → AUTORISATION UTILISATEUR → PRODUCTION → SMOKE / PREUVES ⇒ RELEASED ; conditions PRR levées + ES-001 §26 ⇒ CLOSED. **L'ordre ARCHITECTURE → SPECIFICATION de PLAN-GOVERNANCE-001 est conservé** ; les ajouts sont : l'audit préalable en lecture seule, le staging, l'autorisation utilisateur et le smoke.
3. **PRR allégée définie** (ES-001 §25.4) : complète pour tout nouveau module, nouvelle table ou contrat public, capacité à effet externe, ou changement d'authentification/tenant/permissions ; **allégée** (points ES-001 §25.2 n°2, 3, 5, 6 + smoke) pour un changement mineur d'un module déjà CLOSED sans migration ni contrat public ni permission modifiés.
4. **États** : toujours les états ES-001 §5.1 ; `DONE`, `COMPLETE`, `PLANNED`, `MERGED` ne sont pas des états.
5. **Agents** : l'implémenteur n'est pas son reviewer ; aucun agent ne décide seul d'un merge, d'une dérogation ou d'une écriture production ; la décision de production nomme les rôles (Autorité PRR, puis autorisation de l'utilisateur agissant comme Autorité Produit).
6. **Bases de données** : `db push`, `migrate reset`, `migrate dev` interdits sans exception sur toute base non jetable ; `migrate resolve` seulement sur diagnostic écrit et autorisation.

## 3. Conséquences

- Plus de preuves par lot ; moins de risque d'écriture production non autorisée ; PRR toujours avant production.
- Mise à jour de PLAN-GOVERNANCE-001 **par amendement local** (ES-001 n'est pas modifiée ; elle prévaut).
- Dépend d'un environnement de staging (procédure existante : `docs/acquisition-ops-v2-staging-activation.md`) et de l'identification de la CI (aucun `.github/workflows` dans le dépôt).
- Tant que cet ADR n'est pas accepté, les ajouts du kit sont des **propositions non normatives** ; les règles reprises d'ES-001 / PLAN-GOVERNANCE-001 restent normatives par leur source.

## 4. Alternatives considérées

1. Ne rien changer : lacunes ci-dessus (staging, autorisation, smoke, agents).
2. Règles uniquement dans `.cursor/rules` : fichier non versionné (`.cursor/` est dans `.gitignore`) et décrit par PLAN-GOVERNANCE-001 comme miroir, pas source de vérité.
3. Mettre le kit dans `docs/` : plus conforme à la convention actuelle ; écarté ici par choix de l'utilisateur (racine), à réévaluer par l'Autorité Architecture.
4. PRR après production (variante initialement envisagée) : **rejetée**, contraire à ES-001 §25.4.

## 5. SPEC / TASK d'implémentation connues

Aucune à ce jour (ce kit est la proposition). Première spec pilote : `spec-kit/08-specs/active/vehicles-v2-mileage/`.
