# Domaine — Teams

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (schéma) ; règles métier **À AUDITER**.

| Élément | Constat |
|---------|---------|
| Modèle | `Team` : `name` (unique par entreprise), `color?`, `leaderId` (chef d'équipe **obligatoire**), `active`, `companyId` ; `TeamMember` |
| Relations | `Assignment`, `DailyReport`, `Accommodation`, `Truck?` (un véhicule max), `TruckAssignment` (historique) |
| Page | `/equipes` |
| Code | `src/lib/equipes/equipes-view.ts`, `src/lib/actions/equipe.actions.ts`, composants `src/components/equipes/` (dont `TruckSelector`) |
| Tests | `tests/equipes/` (vue, rendu, panneau) |
| Commits | `6c1c0d8` feat(teams): redesign teams management ; branche locale `feat/equipes-v2-core` (non mergée à ce jour — **À CONFIRMER**) |

## Règles liées à Vehicles (vérifiées)

- Un véhicule par équipe (`Truck.teamId @unique`) ; changer l'équipe d'un véhicule peut en déplacer un autre (`DISPLACED`).
- Une équipe archivée (`active = false`) ne reçoit plus de nouvelle affectation véhicule (`TEAM_INACTIVE`).

## À AUDITER

Suppression d'équipe (`Team.company` = Cascade, FK historiques = Restrict) ; rôle TEAM_LEADER ; relation `leader` (pas de `onDelete` explicite → comportement par défaut de Prisma).
