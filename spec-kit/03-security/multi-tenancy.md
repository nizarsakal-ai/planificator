# Multi-tenancy

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (fichiers cités). Norme supérieure : ES-001 §16.

## Règle maîtresse

Planificator est multi-entreprises. L'isolation se fait par **`companyId`**. **La sécurité tenant ne dépend jamais de l'UI** : toute lecture ou mutation métier conserve l'isolation entreprise et le RBAC **côté serveur**.

## Source du `companyId`

- Le `companyId` et le `role` viennent de la **session** (JWT next-auth), relus en base côté Node (`src/auth.ts`).
- Jamais d'un corps de requête, d'un paramètre d'URL ou d'un champ de formulaire.
- Un compte sans `companyId` est refusé : l'API Vehicles répond `NO_COMPANY` (403). **Même un SUPER_ADMIN sans `companyId` est refusé sur `/api/trucks`** (il n'a pas d'accès global implicite sur cette API).

## Patron de référence (Vehicles)

`src/lib/vehicules/trucks-api.ts` :
- `requireAccess` (`trucks-api.ts:153`) normalise `companyId` (type string, `trim`, non vide) avant tout accès base.
- **Toutes** les requêtes portent `companyId` : `findMany({ where: { companyId } })`, créations avec `companyId`, périodes filtrées par `{ truckId, companyId, endedAt: null }`.
- Les verrous SQL bruts filtrent aussi le tenant : `WHERE "id" = ANY(...) AND "companyId" = ...` (`lockTrucks`, `readActiveTeam`, `readActiveEmployee`).
- Une référence (équipe, chauffeur) d'une **autre** entreprise est traitée comme introuvable (`TEAM_NOT_FOUND`, `DRIVER_NOT_FOUND`), pas comme interdite : aucune fuite d'existence.

## Autres isolations testées

- Booking : `tests/booking/booking-identity-isolation*.test.ts` (dont `*.pg.test.ts`), migration `20260802120000_booking_identity_tenant_isolation`. Invariants : `docs/booking/BOOKING-INVARIANTS.md`.
- Acquisition : tests `multi-gmail-*`, identité des connexions Gmail par entreprise.

## Écarts et risques constatés

| # | Constat | Gravité | Statut |
|---|---------|---------|--------|
| T1 | **Aucun helper central d'isolation tenant** trouvé dans `src/lib/auth/` (il ne contient que des utilitaires Gmail OAuth). 207 fichiers de `src/` mentionnent `companyId` : l'isolation est appliquée **handler par handler**, par convention. | Moyenne (risque d'oubli) | À AUDITER |
| T2 | Le `middleware` exclut `/api` : chaque route API doit authentifier elle-même (voir `rbac.md`). | Élevée si oubli | À AUDITER (aucune cartographie complète) |
| T3 | Les FK `companyId → companies` n'existent pas forcément sur tous les modèles. Vehicles les a (V1A, `ON DELETE RESTRICT`). | À évaluer | À AUDITER |

## Obligations pour toute nouvelle fonctionnalité

1. Dériver `companyId` de la session ; le valider (non vide).
2. Filtrer **chaque** requête Prisma et SQL brute par `companyId`, y compris les lectures de références.
3. Fournir un test « entreprise B ne voit/ne modifie pas les données de l'entreprise A » (modèle : `tests/vehicules/trucks-api.test.ts`).
4. Pour les contraintes d'unicité, penser tenant : `@@unique([matricule, companyId])`.
