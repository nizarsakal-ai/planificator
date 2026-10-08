# Domaine — Worksites (chantiers)

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** (schéma, cron) ; règles métier **À AUDITER**.

| Élément | Constat |
|---------|---------|
| Modèles | `Worksite`, `Client`, `ClientProfile`, `Document`, `Extension`, `DailyReport`, `Signature` |
| Statuts (`WorksiteStatus`) | `PLANNED`, `IN_PROGRESS`, `COMPLETED` (archivage auto après 48 h), `ARCHIVED`, `EXTENDED`, `DELAYED` |
| Transitions automatiques | Cron `/api/cron/chantiers` (05:00) : `DELAYED → IN_PROGRESS` (date de reprise atteinte), `PLANNED → IN_PROGRESS` (date de début atteinte), puis suite du fichier (complétion/archivage — **À AUDITER**) ; protégé par `assertCronBearerAuth` |
| Pages | `/chantiers`, espace client `/mes-chantiers` |
| Code | `src/lib/chantiers/` (`assignment-blocks`, `assignment-ui-policy`, `chantiers-view-filters`), `src/lib/actions/chantier.actions.ts` |
| Tests | `tests/chantiers/` (politique d'affectation, filtres, carte, dates nulles) |
| Migration notable | `20260906160000_worksite_nullable_dates` |
| Commits | `0b17a37` feat(chantiers): add operational search and filtering view (#62) |

## Règle V2 Vehicles

Le chantier peut fournir le **contexte** d'un déplacement (V2-MIL-007). La **distance géographique** d'un chantier n'est **jamais** le kilométrage réellement parcouru (V2-MIL-008).

## À AUDITER

Cron : mises à jour `updateMany` filtrées par tenant ? (le cron agit globalement, sans `companyId` visible dans les premières lignes lues) ; règles d'extension/décalage ; création depuis l'acquisition (conversion).
