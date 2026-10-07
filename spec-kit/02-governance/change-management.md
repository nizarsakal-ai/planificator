# Gestion du changement

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut de vérification : **VÉRIFIÉ** pour PLAN-GOVERNANCE-001 et ES-001 §5, §6, §25, §26 ; l'extension du workflow est une **proposition** (ADR en `09-decisions/`).

## Workflow du Spec Kit (extension, aucune étape supprimée)

```
SPEC → AUDIT READ-ONLY → DESIGN / ADR → VALIDATION DU PÉRIMÈTRE
→ IMPLÉMENTATION → TESTS → REVUE INDÉPENDANTE → CORRECTIONS
→ GIT → PULL REQUEST → MERGE
→ STAGING → VALIDATION
→ PRR (GO) → AUTORISATION UTILISATEUR
→ PRODUCTION → SMOKE / PREUVES  ⇒ RELEASED
→ conditions PRR levées + critères ES-001 §26  ⇒ CLOSED
```

**Invariant** : la PRR (verdict GO ou GO avec conditions, rendu par l'Autorité PRR) **précède toute première mise en production** d'un module ou d'une capacité critique (ES-001 §25.1, §25.4, §6.3).

## Correspondance avec PLAN-GOVERNANCE-001 et les états ES-001 (§5.1)

| Étape du kit | Étape PLAN-GOVERNANCE-001 | État ES-001 |
|--------------|---------------------------|-------------|
| SPEC, AUDIT READ-ONLY, DESIGN / ADR | ARCHITECTURE, SPECIFICATION | PROPOSED → SPECIFIED |
| VALIDATION DU PÉRIMÈTRE | gate de la SPECIFICATION | SPECIFIED |
| IMPLÉMENTATION, TESTS | IMPLEMENTATION | IN_BUILD |
| REVUE INDÉPENDANTE, CORRECTIONS, VALIDATION | INDEPENDENT REVIEW, CORRECTIONS, VALIDATION | IN_REVIEW |
| GIT, PR, MERGE | GIT, PULL REQUEST, MERGE | IN_REVIEW (**merge seul = reste IN_REVIEW**) |
| STAGING + VALIDATION | *(non défini localement — ajout du kit)* | IN_REVIEW |
| PRR (GO) | PRODUCTION READINESS REVIEW | IN_REVIEW |
| AUTORISATION, PRODUCTION, SMOKE | *(autorisation et smoke : ajouts du kit)* | **RELEASED** (déployé dans l'environnement cible) |
| PRR sans condition ouverte + critères §26 | MODULE CLOSED | **CLOSED** |

Précisions normatives de PLAN-GOVERNANCE-001 : `MERGED` n'est pas un état ES-001 (jalon de suivi interne seulement) ; mergé ≠ RELEASED ; RELEASED ≠ CLOSED ; le Done d'une tâche ≠ MODULE CLOSED.

**Vocabulaire du kit** : on écrit l'état ES-001 exact. « DONE », « COMPLETE », « PLANNED » ne sont pas des états : un lot sans spec est simplement **PROPOSED** ou « non spécifié ».

## PRR : complète ou allégée (proposition — à accepter par ADR)

ES-001 §25.4 : pas de production sans PRR pour un module critique ; une **PRR allégée** n'est permise que « si définie par le projet ». Définition proposée :

| Cas | PRR |
|-----|-----|
| Nouveau module, nouvelle table/contrat public, nouvelle capacité à effet externe, changement d'authentification/tenant/permissions | **Complète** (checklist ES-001 §25.2, 10 points) |
| Changement mineur d'un module déjà CLOSED, sans migration, sans contrat public ni permission modifiés | **Allégée** : points 2 (AuthZ/tenant), 3 (chemins critiques testés), 5 (rollback), 6 (sauvegarde) + smoke |

**Vehicles V2 = PRR complète** (nouvelle table, nouvelle API).

## Qui décide (constitution, « Décisions minimales »)

| Décision | Autorité |
|----------|----------|
| ADR | Autorité Architecture |
| SPEC | Autorité Produit (+ Architecture si structurante) |
| Merge standard | Reviewer Indépendant + CI verte |
| PRR | Autorité PRR |
| MODULE CLOSED | Produit + (Architecture ou PRR) |

Une même personne peut cumuler plusieurs rôles dans une petite équipe, mais **chaque décision nomme le rôle** exercé. « L'autorisation utilisateur » du workflow est donnée par la personne agissant comme Autorité Produit/PRR pour la production ; elle **ne remplace pas** la revue indépendante ni la CI pour le merge.

## Règles de changement

1. Un changement structurant exige un ADR (`docs/adr/ADR-PLAN-NNN-*.md`).
2. Une spec référence l'ADR dont elle découle ; l'ADR liste les specs qui l'implémentent.
3. Une dérogation est enregistrée dans le registre des dérogations de la constitution.
4. Une migration suit `04-database/migration-policy.md`.
5. **À CONFIRMER** : si la production se déploie automatiquement depuis `main` (intégration Git de Vercel, non vérifiée), alors **le merge est lui-même une action de production** et la PRR + l'autorisation doivent précéder le merge. Voir `07-deployment/environments.md`.

## Branches et PR

Conventions : ES-001 §7–§9. Observé : une branche par lot (`feat/vehicles-v1a-schema`, `feat/vehicles-v1b-archive-history`, `feat/vehicles-v1b-db-integrity`, `feat/vehicles-v1c-identity-ui`, `fix/vehicles-api-hardening`), commits `feat(domaine): …`.
