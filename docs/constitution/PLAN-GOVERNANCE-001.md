# PLAN-GOVERNANCE-001

| Champ | Valeur |
|-------|--------|
| **Identifiant** | PLAN-GOVERNANCE-001 |
| **Titre** | Gouvernance locale des modules Planificator |
| **Statut** | Normatif — dépôt Planificator |
| **Norme supérieure** | [ENGINEERING-STANDARD-001](./ENGINEERING-STANDARD-001.md) |
| **Audience** | Contributeurs, reviewers |
| **Autorités** | Voir [Constitution — autorités fonctionnelles](./README.md#autorités-fonctionnelles-planificator) |

Ce document **complète** ENGINEERING-STANDARD-001. Il ne le remplace pas.
Les règles détaillées (Git, PR, sécurité, transactions, multi-tenant, tests, PRR, MODULE CLOSED, etc.) sont dans ES-001 ; ce fichier fixe le **cycle opérationnel Planificator** et les **exigences locales**.

---

## Cycle obligatoire des nouveaux modules

Sans saut d’étape :

```
ARCHITECTURE
→ SPECIFICATION
→ IMPLEMENTATION
→ INDEPENDENT REVIEW
→ CORRECTIONS
→ VALIDATION
→ GIT
→ PULL REQUEST
→ MERGE
→ PRODUCTION READINESS REVIEW
→ MODULE CLOSED
```

| Étape locale | Attendu |
|--------------|---------|
| **Architecture** | Frontières, responsabilités, risques, options — avant tout code structurant |
| **Specification** | SPEC / blueprint validés (données, contrats, tests, hors-périmètre) |
| **Implementation** | Développement conforme à la SPEC ; service = autorité métier |
| **Independent Review** | Revue par un **Reviewer Indépendant** (code et, si requis, architecture — ES-001 §10–§11) |
| **Corrections** | Traitement des points bloquants de revue |
| **Validation** | Preuves : tests au niveau de risque, critères d’acceptation |
| **Git / Pull Request / Merge** | Branche dédiée, PR revue, CI requise verte (ES-001 §7–§9) ; merge exceptionnel uniquement via l’Autorité de Merge Exceptionnel |
| **Production Readiness Review** | PRR avant première mise en production critique (ES-001 §25) — verdict par l’Autorité PRR |
| **Module Closed** | Clôture **exclusivement** selon les critères ES-001 §26 |

---

## États de cycle de vie (canoniques ES-001)

Les **seuls** états normatifs de cycle de vie d’un module sont ceux d’ENGINEERING-STANDARD-001 §5.1.
Ils **ne sont pas remplacés** par des libellés locaux.

| État ES-001 | Signification |
|-------------|---------------|
| **PROPOSED** | Besoin identifié, pas encore engagé |
| **SPECIFIED** | Spec / blueprint validés |
| **IN_BUILD** | Implémentation en cours |
| **IN_REVIEW** | Revues qualité / architecture en cours |
| **RELEASED** | Disponible en environnement cible |
| **CLOSED** | Critères MODULE CLOSED satisfaits (ES-001 §26) |
| **DEPRECATED** | Maintenance minimale, sortie planifiée |
| **RETIRED** | Retiré, plus de support actif |

### Correspondance jalons opérationnels Planificator → états ES-001

| Jalon Planificator | État ES-001 associé |
|--------------------|---------------------|
| Architecture / proposition | **PROPOSED** |
| SPEC validée | **SPECIFIED** |
| Implémentation en cours | **IN_BUILD** |
| Audit / revue / corrections / validation | **IN_REVIEW** |
| Merge seul | reste **IN_REVIEW**, ou devient **RELEASED** **uniquement** après mise à disposition dans l’environnement cible |
| Déployé / disponible dans l’environnement cible | **RELEASED** |
| PRR validée + critères ES-001 §26 satisfaits | **CLOSED** |

### Clarifications normatives

- **`MERGED` n’est pas un état de cycle de vie ES-001.**
- Un code **mergé** n’est **pas** nécessairement **RELEASED**.
- **RELEASED** n’est **pas** **CLOSED**.
- Le **Done** d’une tâche n’est **pas** **MODULE CLOSED**.
- **MODULE CLOSED** est régi **exclusivement** par ES-001 §26.

### Jalons de suivi interne (non normatifs)

Les termes `APPROVED`, `IMPLEMENTING`, `IMPLEMENTED`, `VALIDATED`, `MERGED` **PEUVENT** servir de jalons de suivi interne (tickets, board).
Ils **NE DOIVENT PAS** être présentés comme les états normatifs du module. L’état normatif reste toujours l’un des états ES-001 §5.1 ci-dessus.

---

## Exigences non négociables (Planificator)

- Architecture et SPEC avant toute implémentation structurante
- Service = autorité métier ; UI sans logique métier ; actions = wrappers fins
- Validation Zod stricte côté serveur
- Isolation multi-tenant via `companyId`
- Transactions atomiques pour les intentions métier qui doivent réussir ou échouer ensemble
- Optimistic locking lorsque la concurrence l’exige
- Tests unitaires ; tests d’intégration PostgreSQL lorsque le métier l’exige
- Aucune fusion sans revue indépendante
- Aucun module terminé avant **MODULE CLOSED** (ES-001 §26)
- Audits = constats vérifiés dans le dépôt uniquement (pas de suppositions)

---

## Audit

- Un audit **doit** s’appuyer uniquement sur des preuves présentes dans le dépôt (fichiers, historique Git, CI, docs versionnées).
- Les affirmations non vérifiables **ne font pas foi**.
- Tout écart au cycle ou aux exigences **doit** être signalé immédiatement.

---

## Dérogations

Toute dérogation à ce document ou à ES-001 **doit** être enregistrée dans le [registre des dérogations](./README.md#dérogations), selon les règles et autorités de la constitution.

---

## Annexe — Instructions pour agents automatisés

Cette annexe **adapte** la gouvernance aux assistants automatisés.
Elle **ne remplace pas** les obligations humaines Git, PR, review et PRR.

- Le document `docs/constitution/PLAN-GOVERNANCE-001.md` reste la **source versionnée** de la gouvernance locale.
- `.cursor/rules` **pourra** devenir un miroir technique dans un **lot séparé** ; ce n’est pas la source de vérité humaine.
- **Aucun agent** ne peut autoriser **seul** une dérogation, un merge exceptionnel ou **MODULE CLOSED**.

Obligations des agents :

- Respecter le **MODE** demandé (lecture seule / implémentation / staging / commit, etc.).
- Aucune modification hors périmètre autorisé.
- Aucune action Git (commit, push, PR, merge) ni action de production sans **instruction explicite**.
- Audits fondés uniquement sur des **preuves du dépôt**.
- Signaler immédiatement tout écart au cycle, à PLAN-GOVERNANCE-001 ou à ES-001.
