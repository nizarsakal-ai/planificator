# Règles d'ingénierie

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** — ce fichier **résume et renvoie** vers ES-001 et PLAN-GOVERNANCE-001. En cas de divergence, ES-001 prévaut.

## Hiérarchie documentaire (docs/constitution/README.md)

ES-001 → PLAN-GOVERNANCE-001 → ADR → SPEC → TASK → implémentation.

## Exigences non négociables (source : section « Exigences non négociables » de `docs/constitution/PLAN-GOVERNANCE-001.md` ; le fichier `.cursor/rules/plan-governance-001.mdc` en est un miroir local non versionné)

- Architecture et SPEC avant toute implémentation.
- Service = autorité métier ; UI sans logique métier ; actions = wrappers fins.
- Zod strict ; multi-tenant (`companyId`) ; transactions atomiques ; **optimistic locking lorsque la concurrence l'exige** (PLAN-GOVERNANCE-001). Le kit relève en plus une technique observée dans Vehicles : verrous de ligne SQL (`FOR UPDATE`, ordre fixe) — voir `04-database/concurrency.md`.
- Tests unitaires ; tests PostgreSQL si le métier l'exige.
- Aucune fusion sans revue indépendante.
- Audits = constats vérifiés dans le dépôt uniquement.

## Index vers ES-001

| Sujet | Section ES-001 |
|-------|----------------|
| Cycle de vie d'un module | §5 |
| Definition of Done | §6 |
| Git, branches, PR | §7–§9 |
| Code review / Architecture review | §10–§11 |
| Base de données | §12 |
| API | §13 |
| Sécurité | §14 |
| Transactions | §15 |
| Multi-tenant | §16 |
| Feature flags | §17 |
| Tests | §18 |
| Observabilité | §19 |
| Documentation / ADR | §20–§21 |
| Performance | §22 |
| Déploiement / Rollback | §23–§24 |
| PRR / MODULE CLOSED | §25–§26 |

## Conventions de code observées (Vehicles, référence actuelle)

- Handlers à dépendances injectées (`{ auth, db }`) ; routes API minces.
- Codes d'erreur typés, statut HTTP et message stables, erreurs Prisma classifiées.
- Commentaires d'en-tête qui énoncent les invariants et la compatibilité de déploiement.
- Commentaires en français ; identifiants de code en anglais ou en français selon le domaine (pas de renommage de masse).

## Interdits

- Réécrire `docs/constitution/ENGINEERING-STANDARD-001.md` (copie synchronisée, voir README constitution).
- Créer un ADR fictif (`docs/adr/README.md`).
- Commit / push / PR / merge / déploiement sans demande explicite de l'utilisateur.
