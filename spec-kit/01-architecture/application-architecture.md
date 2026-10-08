# Architecture applicative

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (arborescence `src/`, fichiers cités) ; conventions déduites d'exemples réels, pas encore d'un audit exhaustif des 477 fichiers TS/TSX de `src/` (`git ls-files src`).

## Couches (`src/`)

| Couche | Emplacement | Rôle |
|--------|-------------|------|
| Pages / layouts | `src/app/(auth|dashboard|client)/**` | Rendu, redirection selon l'accès |
| Routes API | `src/app/api/**/route.ts` | Adaptateurs HTTP minces |
| Server actions | `src/lib/actions/*.actions.ts` | Wrappers minces ; la logique est dans `*.core.ts` quand elle existe |
| Domaine | `src/lib/<domaine>/` | Services, règles, schémas Zod, vues (ex. `vehicules`, `acquisition`, `booking`, `integration`, `chantiers`, `employes`, `equipes`, `billing`) |
| Composants | `src/components/<domaine>/` | UI ; `src/components/ui` = primitives (shadcn/Radix) |
| Accès base | `src/lib/prisma.ts` | Client Prisma unique |
| Validation | `src/lib/validations/` + schémas Zod au plus près du domaine | Zod strict |

## Pattern de référence : injection des dépendances (Vehicles)

`src/app/api/trucks/route.ts` ne contient **aucune logique** : il appelle `handleTrucksGet({ auth, db: prisma })` défini dans `src/lib/vehicules/trucks-api.ts`. Le handler reçoit `auth` et `db` en paramètres, ce qui permet de le tester (`tests/vehicules/trucks-api.test.ts`, ~1100 lignes) sans base ni session réelles.

Même idée dans `src/lib/actions/*.core.ts` (ex. `employe-delete.core.ts`, `invitation-accept.core.ts`, `acquisition-review.actions.core.ts`) : la partie testable est séparée du wrapper Next.

**Règle** : toute nouvelle route ou action sensible suit ce modèle (dépendances injectées, erreurs typées, jamais de message brut exposé).

## Erreurs

Vehicles définit des codes d'erreur typés avec statut HTTP fixe et message stable (`TrucksErrorCode`, liste complète dans `src/lib/vehicules/trucks-api.ts` lignes 43-60 : `UNAUTHENTICATED`, `FORBIDDEN`, `NO_COMPANY`, `INVALID_JSON`, `INVALID_PAYLOAD`, `TRUCK_NOT_FOUND`, `TEAM_NOT_FOUND`, `DRIVER_NOT_FOUND`, `MATRICULE_CONFLICT`, `TEAM_CONFLICT`, `TRUCK_ARCHIVED`, `TRUCK_ARCHIVED_EXISTS`, `TEAM_INACTIVE`, `DRIVER_INACTIVE`, `PERIOD_CONFLICT`, `CONCURRENT_UPDATE`, `SERVER_ERROR`). Les erreurs Prisma (P2002, P2003, P2025) sont **classifiées** en codes métier ; rien d'autre n'est exposé au client. Journalisation sans message brut.

## Contraintes d'architecture testées

`tests/integration/architecture/no-forbidden-imports.test.ts` et `integration-exports-surface.test.ts` font respecter des frontières d'imports pour la plateforme d'intégration. Toute nouvelle frontière stricte doit être **testée**, pas seulement documentée.

## À AUDITER

- Les domaines hors Vehicles/Acquisition/Booking/Integration n'ont pas été audités pour savoir s'ils suivent le même pattern.
- Existence d'un helper central d'isolation tenant : **aucun trouvé** dans `src/lib/auth/` (contient seulement des utilitaires Gmail OAuth). Voir `03-security/multi-tenancy.md`.
