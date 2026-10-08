# Architecture système

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** sur `origin/main` e707381 (fichiers cités) sauf mention.

## Vue d'ensemble

```
Navigateur / PWA / shell iOS (Capacitor)
        │
        ▼
Vercel — Next.js 15 (App Router)
  ├─ src/middleware.ts        auth sur les PAGES (le matcher exclut /api)
  ├─ src/app/(auth)           login, inscription, invitation, mot de passe
  ├─ src/app/(dashboard)      application interne (ADMIN, TEAM_LEADER, EMPLOYEE…)
  ├─ src/app/(client)         espace client (mes-chantiers)
  └─ src/app/api/**           routes API et crons (authentification PROPRE à chaque route)
        │
        ▼
PostgreSQL (Prisma 5.22, `DATABASE_URL`)        Services externes : Gmail (OAuth),
                                                 Anthropic, Cloudinary, Resend
```

## Faits structurants

| Sujet | Constat | Source |
|-------|---------|--------|
| Authentification | next-auth v5 beta ; le JWT porte `role` et `companyId`, relus en base côté Node | `src/auth.ts`, `src/auth.config.ts` |
| Middleware | Config Edge sans Prisma ; **le matcher exclut `/api`** : une route API non protégée est publique | `src/middleware.ts` |
| Crons | 3 crons Vercel : `/api/cron/chantiers` (05:00), `/api/cron/gmail-scan` (08:00), `/api/cron/acquisition-orchestrator` (toutes les heures) | `vercel.json` |
| Auth des crons | `assertCronBearerAuth` (Bearer `CRON_SECRET`) | `src/lib/cron/assert-cron-bearer-auth.ts` |
| PWA | Service worker généré dans `public/`, activation immédiate (`skipWaiting`, `clientsClaim`) | `next.config.ts` |
| Build | `prisma generate && next build` ; **le build Vercel n'exécute pas `migrate deploy`** | `package.json`, en-têtes des migrations Vehicles |
| Documents PDF | Routes `/api/pdf/*` avec `@react-pdf/renderer` | `src/app/api/pdf/` |

## Frontières à respecter

1. `src/app/api/**` et `src/app/**/page.tsx` sont des **adaptateurs** : authentification, lecture de la session, appel d'un service/handler.
2. La logique métier vit dans `src/lib/<domaine>/` et `src/lib/actions/*.actions.ts` (voir `application-architecture.md`).
3. Aucune route ne fait confiance à un `companyId` ou un rôle venant du client : ils viennent de la session (voir `03-security/multi-tenancy.md`).

## À AUDITER

- Cartographie exhaustive des routes API et de leur contrôle d'accès (aucun audit complet à ce jour).
- Politique de rate limiting, CSP et en-têtes de sécurité.
- Environnements Vercel (preview / staging / production) : voir `07-deployment/environments.md`.
