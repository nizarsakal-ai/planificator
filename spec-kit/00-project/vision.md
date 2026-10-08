# Vision

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (README.md du dépôt, `prisma/schema.prisma`) sauf mention contraire.

Planificator est une application de **planification et de gestion opérationnelle des équipes, chantiers et ressources** (README.md).

## Nature du produit

- SaaS **multi-entreprises** : chaque entreprise (`Company`) est un tenant, isolé par `companyId`.
- Stack constatée dans `package.json` : Next.js 15, React 19, TypeScript 5, Prisma 5.22 sur PostgreSQL, next-auth v5 (beta), Tailwind, Zod. Application web PWA (`@ducanh2912/next-pwa`) avec un shell iOS Capacitor (`ios/`, `capacitor.config.ts`).
- Hébergement : Vercel (`vercel.json`, crons).
- Domaines couverts par le schéma : entreprises, utilisateurs, employés, équipes, véhicules, chantiers, affectations, absences, pointage, rapports journaliers, documents, logements, devis/factures, notes de frais, acquisition d'e-mails, réservation (booking), plateforme d'intégration.

## Principes directeurs (issus de ES-001 et PLAN-GOVERNANCE-001)

1. La **sécurité tenant ne dépend jamais de l'UI** : toute lecture ou mutation métier est isolée par entreprise et contrôlée par rôle **côté serveur**.
2. Le **service est l'autorité métier** ; l'UI n'a pas de logique métier ; les actions sont des wrappers fins.
3. **Prisma est le modèle applicatif, PostgreSQL porte aussi les invariants** qui exigent une garantie base de données (contraintes CHECK, triggers, FK RESTRICT) — voir `04-database/integrity-rules.md`.
4. Aucune donnée historique n'est effacée silencieusement.
5. Les fonctions sensibles sont livrées **inactives par défaut** derrière des feature flags (ex. `PLANIFICATOR_ACQUISITION_ENABLED`).
6. Les audits sont des **constats vérifiés dans le dépôt**, jamais des suppositions.
