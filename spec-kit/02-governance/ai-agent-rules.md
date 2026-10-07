# Règles pour les agents IA (Claude, Cursor, sous-agents)

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **Draft**. Les points 1 à 4 reprennent l'**Annexe « Instructions pour agents automatisés » de `docs/constitution/PLAN-GOVERNANCE-001.md`** (VÉRIFIÉ ; `.cursor/rules/plan-governance-001.mdc` n'en est qu'un miroir local non versionné). Les points 5 à 10 sont des **ajouts du kit**, proposés dans l'ADR (non normatifs tant qu'il n'est pas accepté).

## Règles reprises du dépôt

1. Respecter le **MODE demandé** : lecture seule / implémentation / staging / commit.
2. **Ne pas** commit / push / PR / merge / déployer sans demande explicite.
3. Signaler immédiatement tout écart au cycle PLAN-GOVERNANCE-001 ou aux exigences.
4. Un audit rapporte uniquement des **constats vérifiés dans le dépôt**.

## Règles ajoutées par le Spec Kit

5. **Lire avant d'agir** : README du kit, ce fichier, le fichier du domaine, la spec active. Un agent ne réinvente pas les règles de Planificator.
6. **Un agent qui implémente n'est jamais son propre reviewer indépendant.** La revue est faite par une autre instance, avec un contexte neuf, qui lit le diff et la spec, pas le raisonnement de l'implémenteur.
7. **Aucun agent ne décide seul d'un merge ni d'une écriture en production** (PLAN-GOVERNANCE-001 : aucun agent n'autorise seul une dérogation, un merge exceptionnel ou MODULE CLOSED). Production = **PRR GO** (Autorité PRR) **puis** autorisation explicite de l'utilisateur, par action, jamais généralisée.
8. **Respecter le périmètre de la spec.** Ce qui est « hors périmètre » n'est pas ajouté, même utile. Toute découverte hors périmètre est signalée, pas implémentée.
9. **Secrets** : ne jamais ouvrir, afficher ni copier le contenu de `.env*`. Citer des **noms** de variables seulement.
10. **Base de données** : jamais `prisma db push`, `migrate reset`, `migrate dev` ni réparation SQL improvisée sur une base non jetable, **sans exception**. `migrate resolve` seulement après diagnostic écrit et autorisation explicite. Détail : `04-database/migration-policy.md`.

## Rôles du système de délégation

```
UTILISATEUR → SPEC KIT → ORCHESTRATEUR
   ├─ Architect       : conçoit, écrit l'ADR/la spec, n'implémente pas
   ├─ Implementer     : code dans le périmètre validé, écrit les tests
   └─ DB / Security   : audite schéma, migrations, tenant, RBAC
        ↓
   Revue indépendante (autre instance) → Tests / preuves → PRR (GO) → AUTORISATION UTILISATEUR
```

| Rôle | Peut | Ne peut pas |
|------|------|-------------|
| Orchestrateur | Lire le kit, découper, déléguer, agréger les preuves | Écrire en production, merger, approuver sa propre délégation |
| Architect | Proposer ADR/spec | Implémenter |
| Implementer | Coder, tester localement | S'auto-relire, élargir le périmètre |
| DB / Security | Auditer en lecture seule, rédiger un plan de migration | Exécuter une migration en staging/production **sans autorisation explicite** ; jamais `db push` / `migrate reset` / `migrate dev` sur base non jetable |
| Reviewer indépendant | Lire diff + spec + tests, rendre un verdict motivé | Corriger à la place de l'implémenteur sans rendre un nouveau verdict |

## Contrat de délégation (à inclure dans chaque tâche confiée à un sous-agent)

- Objectif et critère d'acceptation (identifiants d'exigences, ex. `V2-MIL-004`).
- MODE (lecture seule / implémentation) et périmètre de fichiers.
- Interdits explicites (voir règles 2, 7, 9, 10).
- Format de rapport : constats avec chemins et lignes, tests exécutés, ce qui n'a **pas** été vérifié.

## Traçabilité exigée

Chaque exigence se relie à : **implémentation → test → preuve** (tableau dans `acceptance.md` de la spec).
