# Staging

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : procédure **VÉRIFIÉE** dans `docs/acquisition-ops-v2-staging-activation.md` (procédure ops existante ; ce n'est pas un runbook au sens de `docs/runbooks/README.md`, qui impose le format `RB-PLAN-NNN` et dit « aucun runbook réel » à ce jour). Elle sert de modèle. Étape STAGING du workflow du kit : **DÉCISION REQUISE** pour l'adopter formellement (voir ADR proposé).

## Séquence (reprend le runbook staging)

1. **GO / NO-GO d'identification** : projet Vercel staging, hôte de base staging distinct, `CRON_SECRET` défini et distinct, tenant de test connu.
2. **Backup vérifiable** avant migration (snapshot de la base staging). Sans backup vérifiable : NO-GO.
3. **Migrations manuelles** sur la base **staging uniquement** : `npx prisma migrate status`, puis `npx prisma migrate deploy` (Vercel ne les exécute pas), puis statut après.
4. Déploiement du code dans l'ordre exigé par l'en-tête de la migration.
5. Validation fonctionnelle sur le tenant de test ; preuves (sorties, captures) conservées.
6. Rapport : ce qui a été vérifié, ce qui ne l'a pas été.

## Interdits pour un agent

Exécuter `migrate deploy` ou activer un flag sans demande explicite ; toucher à une base dont l'hôte n'est pas confirmé comme staging.
