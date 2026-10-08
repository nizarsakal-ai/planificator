# Politique de revue

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : règles normatives du kit ; ES-001 §10 (code review) et §11 (architecture review) prévalent.

## Principe

**Un agent ou une personne qui a implémenté n'est jamais son propre reviewer indépendant.** « Indépendant » = autre instance, contexte neuf, lit le diff, la spec et les tests, pas le raisonnement de l'auteur.

## Checklist du reviewer

1. **Périmètre** : le diff reste dans la spec ; rien de « hors périmètre » n'a été ajouté.
2. **Tenant** : `companyId` vient de la session et filtre **toutes** les requêtes (Prisma et SQL brut) ; test inter-entreprises présent.
3. **RBAC** : rôles vérifiés côté serveur, dans le bon ordre (401 → 403 → `NO_COMPANY`) ; constantes de rôles testées.
4. **Base** : migration conforme à `migration-policy.md` (en-tête complet, gardes, assertions, ordre de déploiement, rollback) ; schéma Prisma cohérent ; aucun `db push`.
5. **Concurrence** : verrous dans un ordre fixe, 409 typés, idempotence des tâches répétées.
6. **Erreurs** : codes typés, aucun message brut exposé, aucun secret ni contenu sensible dans les logs.
7. **Tests** : exigences → tests → preuves ; scripts `package.json` mis à jour (liste codée en dur).
8. **Documentation** : `modules-status.md` mis à jour ; ADR si changement structurant.
9. **Honnêteté du rapport** : ce qui n'a pas été vérifié est dit.

## Verdict

`APPROUVÉ` / `APPROUVÉ SOUS RÉSERVE` (liste de points) / `REFUSÉ` (points bloquants). Chaque point cite fichier et ligne.

## Qui décide du merge

Constitution (« Décisions minimales ») : **merge standard = Reviewer Indépendant + CI verte** ; merge exceptionnel = Autorité de Merge Exceptionnel (incident urgent documenté). Aucun agent n'autorise seul un merge exceptionnel ni une dérogation (PLAN-GOVERNANCE-001, annexe). Dans ce dépôt, un agent n'exécute un merge que sur **instruction explicite**. **À CONFIRMER** : la CI n'étant pas identifiée dans le dépôt, le reviewer consigne la vérification qui la remplace.
