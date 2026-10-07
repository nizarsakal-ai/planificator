# RBAC

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (`prisma/schema.prisma`, `src/lib/vehicules/*`, `src/middleware.ts`). Norme : ES-001 §14.

## Rôles (enum `Role`)

| Rôle | Définition dans le schéma |
|------|---------------------------|
| `SUPER_ADMIN` | Accès global, gère toutes les entreprises |
| `ADMIN` | Gère son entreprise uniquement |
| `TEAM_LEADER` | Consulte et confirme/refuse les affectations de son équipe |
| `EMPLOYEE` | Consulte son propre planning |
| `CLIENT` | Consulte ses chantiers et le planning associé |

## Où le contrôle a lieu

| Surface | Mécanisme | Source |
|---------|-----------|--------|
| Pages (hors `/api`) | `middleware` + `authConfig.callbacks.authorized` | `src/middleware.ts`, `src/auth.config.ts` |
| **Routes API** | **Non couvertes par le middleware** : chaque route appelle `auth()` et contrôle rôle + entreprise | `src/app/api/**` |
| Crons / APIs machine | `assertCronBearerAuth` (fail-closed : 401 si `CRON_SECRET` absent, vide ou `"undefined"`) | `src/lib/cron/assert-cron-bearer-auth.ts` |
| Pages serveur | Résolveur d'accès par page (ex. `resolveVehiclesAccess`) | `src/lib/vehicules/vehicules-view.ts` |

## Matrice constatée — Vehicles

| Action | Rôles API (`trucks-api.ts`) | Page `/vehicules` |
|--------|------------------------------|-------------------|
| Lire (`GET /api/trucks`) | SUPER_ADMIN, ADMIN, TEAM_LEADER | SUPER_ADMIN, ADMIN seulement |
| Créer / modifier (`POST`, `PATCH`) | SUPER_ADMIN, ADMIN, TEAM_LEADER | — |
| Archiver / restaurer / `DELETE` (= archivage) | SUPER_ADMIN, ADMIN | — |

**Écart constaté** : l'API autorise TEAM_LEADER en lecture/écriture alors que la page refuse ce rôle (redirection vers `/dashboard`). Le code note que TEAM_LEADER **n'est pas restreint à son équipe « pour l'instant »** (en-tête de `trucks-api.ts`). **DÉCISION REQUISE** : restreindre à l'équipe, ou retirer le rôle de l'API.

## Règles

1. **Toute route API s'authentifie elle-même**, selon l'un de trois mécanismes : `auth()` + rôle + entreprise (routes utilisateur) ; `assertCronBearerAuth` (crons) ; `state` signé pour le callback OAuth Gmail (`src/app/api/auth/gmail/callback`). Pour les routes utilisateur : rôle **puis** entreprise, avant tout accès base. Ordre d'erreurs Vehicles : 401 non authentifié → 403 rôle → 403 `NO_COMPANY`.
2. Les rôles autorisés sont des **constantes exportées et testées** (`TRUCKS_READ_ROLES`, `TRUCKS_WRITE_ROLES`, `TRUCKS_ARCHIVE_ROLES`), pas des chaînes dispersées.
3. Le rôle d'un utilisateur est relu en base (JWT callback), pour qu'un changement de rôle ou une désactivation prenne effet.
4. L'UI peut masquer des actions, **jamais** les protéger.
5. Les rôles `EMPLOYEE` et `CLIENT` n'ont accès à aucune ressource d'une autre personne : à tester pour chaque nouvelle route.

## À AUDITER

- Matrice RBAC des autres domaines (employés, chantiers, factures, absences, documents).
- Existence de routes API sans `auth()`.
