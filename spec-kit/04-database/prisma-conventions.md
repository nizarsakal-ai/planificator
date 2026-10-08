# Conventions Prisma

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (`prisma/schema.prisma` et migrations Vehicles sur origin/main). Norme : ES-001 §12.

## Principe

**Prisma est le modèle applicatif ; PostgreSQL porte aussi les invariants qui nécessitent une garantie base de données.** Ce que Prisma ne sait pas exprimer (CHECK, triggers, index partiels, verrous) vit dans des migrations SQL écrites à la main, mais **le schéma Prisma doit rester cohérent** avec elles (colonnes, index, FK identiques à `prisma migrate diff`).

## Conventions observées

| Sujet | Convention | Exemple |
|-------|------------|---------|
| Identifiants | `String @id @default(cuid())` | `Truck.id` |
| Tables | `@@map("snake_case_pluriel")` | `trucks`, `truck_assignments` |
| Tenant | colonne `companyId` + `@@index([companyId])` | `Truck`, `TruckAssignment` |
| Unicité tenant | `@@unique([champ, companyId])` | `@@unique([matricule, companyId])` |
| Suppression d'une référence historique | `onDelete: Restrict` | `TruckAssignment.truck/company/chauffeur/team` |
| Suppression d'une référence d'état courant | `onDelete: SetNull` quand NULL a un sens métier | `Truck.team`, `Truck.chauffeur` |
| Documentation de colonne | commentaires `///` pour les invariants SQL | `openForTruckId`, `reason` |
| Enums | valeur de repli explicite quand une donnée ancienne est indémontrable | `TruckAssignmentReason.BACKFILL` |
| Colonne technique pilotée par trigger | **ne jamais l'écrire depuis l'application** | `openForTruckId` |
| Sérialisation de concurrence | verrous SQL bruts (`FOR UPDATE` / `FOR SHARE`) via `tx.$queryRaw` | `lockTrucks`, `readActiveTeam` |

## Règles

1. Toute modification de `schema.prisma` s'accompagne d'une migration dans `prisma/migrations/` (jamais `db push`).
2. Une colonne ajoutée est **additive et nullable** (ou avec DEFAULT) tant que du code déjà déployé ne la connaît pas. Pas de DROP / renommage dans la même livraison qu'un changement de code qui en dépend.
3. Une nouvelle table métier porte `companyId`, un index dessus, et une FK vers `Company` (RESTRICT pour l'historique).
4. Les erreurs Prisma exposées au client sont **classifiées** (P2002 unicité, P2003 clé étrangère, P2025 introuvable, P2004 CHECK) ; aucun message brut ne sort.
5. Après changement de schéma : `prisma generate` (le build le fait : `prisma generate && next build`).
6. **Prisma 5.22** : ne pas supposer des fonctionnalités des versions ultérieures.

## À AUDITER

- Cohérence des autres modèles avec ces conventions (cuid partout ? FK `companyId` partout ?).
- Politique d'index pour les tables acquisition volumineuses.
