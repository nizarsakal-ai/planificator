# Planificator — Spec Kit

| Champ | Valeur |
|-------|--------|
| **Rôle** | **Complément opérationnel** de la gouvernance du dépôt, à lire par Claude, Cursor et les contributeurs avant toute délégation ou implémentation. Il ne remplace ni ES-001, ni PLAN-GOVERNANCE-001, ni les ADR, ni les specs de `docs/`. |
| **Audience** | Agents IA, contributeurs, architecture |
| **Base auditée** | `origin/main` au commit `e707381` (feat(vehicles): add V1C identity and fleet UI), audit du 2026-10-07 |
| **Statut** | **Draft** (ES-001 §20.4). Les parties qui reprennent ES-001 / PLAN-GOVERNANCE-001 renvoient à ces documents ; les **ajouts propres au kit** (workflow étendu, règles agents, politiques qualité/déploiement) sont des **propositions** tant que l'ADR de [`09-decisions/`](09-decisions/ADR-PROPOSAL-spec-kit-workflow.md) n'est pas accepté par l'Autorité Architecture. |
| **Revue** | Revue indépendante réalisée le 2026-10-07 (verdict : approuvé sous réserve) ; corrections appliquées |

## Ce que ce kit est, et n'est pas

- Il **complète** la gouvernance existante, il ne la remplace pas :
  - [`docs/constitution/ENGINEERING-STANDARD-001.md`](../docs/constitution/ENGINEERING-STANDARD-001.md) (ES-001) est la **norme supérieure**. Copie protégée : ne jamais la modifier ici.
  - [`docs/constitution/PLAN-GOVERNANCE-001.md`](../docs/constitution/PLAN-GOVERNANCE-001.md) fixe le cycle local des modules.
  - Les ADR vivent dans [`docs/adr/`](../docs/adr/README.md) (`ADR-PLAN-NNN-titre.md`). Le dossier `09-decisions/` ne crée pas de second système.
- En cas de conflit, la règle la plus stricte sur la sécurité, l'intégrité et la traçabilité prévaut (ES-001, préambule).
- Chaque fichier indique ce qui est **vérifié dans le dépôt** et ce qui est **À CONFIRMER / À AUDITER**. Aucune règle ne doit être déduite d'un souvenir : en cas de doute, auditer le code.

## Lecture obligatoire avant de déléguer ou d'implémenter

1. [`02-governance/ai-agent-rules.md`](02-governance/ai-agent-rules.md)
2. [`02-governance/engineering-rules.md`](02-governance/engineering-rules.md)
3. [`03-security/multi-tenancy.md`](03-security/multi-tenancy.md) et [`03-security/rbac.md`](03-security/rbac.md)
4. [`04-database/migration-policy.md`](04-database/migration-policy.md) si la tâche touche `prisma/`
5. Le fichier du domaine concerné dans [`05-domains/`](05-domains/) et la spec active dans [`08-specs/active/`](08-specs/active/)

## Workflow cible

```
SPEC → AUDIT READ-ONLY → DESIGN / ADR → VALIDATION DU PÉRIMÈTRE
→ IMPLÉMENTATION → TESTS → REVUE INDÉPENDANTE → CORRECTIONS
→ GIT → PULL REQUEST → MERGE
→ STAGING → VALIDATION
→ PRR (GO) → AUTORISATION UTILISATEUR
→ PRODUCTION → SMOKE / PREUVES  ⇒ RELEASED
→ conditions PRR levées + critères ES-001 §26  ⇒ CLOSED
```

Principes : aucune étape de PLAN-GOVERNANCE-001 n'est supprimée ; **la PRR précède toujours la production** (ES-001 §25.1 et §25.4) ; « DONE » n'est pas un état du kit (il y a RELEASED puis CLOSED).

Correspondance avec les états ES-001 et le cycle PLAN-GOVERNANCE-001 : voir [`02-governance/change-management.md`](02-governance/change-management.md).
**L'audit en lecture seule préalable, le STAGING, l'AUTORISATION UTILISATEUR et le SMOKE ne figurent pas dans PLAN-GOVERNANCE-001 : leur adoption passe par un ADR** (proposé : [`09-decisions/ADR-PROPOSAL-spec-kit-workflow.md`](09-decisions/ADR-PROPOSAL-spec-kit-workflow.md)).

## Carte

| Dossier | Contenu |
|---------|---------|
| `00-project/` | Vision, périmètre, glossaire |
| `01-architecture/` | Système, application, données, intégrations |
| `02-governance/` | Règles d'ingénierie, règles agents IA, gestion du changement, Definition of Done |
| `03-security/` | Multi-tenant, RBAC, secrets, sûreté production |
| `04-database/` | Conventions Prisma, politique de migration, intégrité, concurrence |
| `05-domains/` | Un fichier par domaine + état des modules |
| `06-quality/` | Tests, régression, revue |
| `07-deployment/` | Environnements, staging, production, rollback |
| `08-specs/` | Gabarit de feature spec + specs actives (Vehicles V2) |
| `09-decisions/` | Renvoi vers `docs/adr/` + proposition d'ADR |

## Légende des marqueurs

- **VÉRIFIÉ** : constaté dans le dépôt (fichier cité).
- **À CONFIRMER** : probable mais non vérifié, ne pas s'y fier sans audit.
- **À AUDITER** : aucun audit effectué à ce jour.
- **DÉCISION REQUISE** : choix à faire par l'utilisateur.
