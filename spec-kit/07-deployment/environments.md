# Environnements

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** pour ce qui est écrit dans `vercel.json`, `package.json` et `docs/acquisition-ops-v2-staging-activation.md` ; **À CONFIRMER** pour la configuration réelle des projets Vercel (non consultée).

| Environnement | Constat | Source |
|---------------|---------|--------|
| Local | `next dev`, base locale ; scripts `db:*` (dont `db:push`, `db:reset` à risque) | `package.json` |
| Staging | Projet Vercel **dédié** (ex. `planificator-staging`), base PostgreSQL **distincte** de la production, `CRON_SECRET` distinct | `docs/acquisition-ops-v2-staging-activation.md` |
| Production | Projet Vercel de production ; crons déclarés dans `vercel.json` (chantiers 05:00, gmail-scan 08:00, acquisition-orchestrator horaire) | `vercel.json` |

## Règles

1. **NO-GO** si le projet Vercel ou l'hôte de base correspond à la production alors qu'on vise le staging (règle du runbook staging).
2. Les variables d'environnement de staging et de production sont distinctes (clés, `DATABASE_URL`, `CRON_SECRET`).
3. Le build Vercel exécute `prisma generate && next build` et **n'applique aucune migration**.
4. Le dossier `.vercel/` du poste local n'est pas suivi par Git (0 fichier suivi) ; ne jamais le publier.
5. **À CONFIRMER** : si Vercel déploie automatiquement la production depuis `main`, le merge vaut action de production (voir `02-governance/change-management.md`). La configuration Git des projets Vercel n'a pas été consultée.
6. Flags : valeur par défaut = inactif ; activation documentée par environnement (`docs/RB-PLAN-ACQ-001-activation-flags.md`).

## À AUDITER

Liste exacte des projets Vercel et de leurs branches de déploiement ; stratégie de preview ; protection des déploiements ; propriétaires des accès.
