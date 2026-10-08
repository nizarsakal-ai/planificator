# Décisions (ADR)

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

**Il n'y a pas de second système d'ADR.** Les ADR officiels vivent dans [`docs/adr/`](../../docs/adr/README.md) avec la convention `ADR-PLAN-NNN-titre-court.md` (ES-001 §21). À ce jour : **aucun ADR** (index vide).

Ce dossier contient seulement :

- [`ADR-template.md`](ADR-template.md) : rappel du contenu minimal (identique à `docs/adr/README.md`).
- [`ADR-PROPOSAL-spec-kit-workflow.md`](ADR-PROPOSAL-spec-kit-workflow.md) : **brouillon** proposant l'emplacement et le statut du kit, l'extension du workflow (audit, staging, PRR avant production, autorisation, smoke), la définition de la PRR allégée et l'interdiction de `db push` / `migrate reset` / `migrate dev` sur base partagée. Il devient `docs/adr/ADR-PLAN-001-…md` **uniquement** après validation par l'Autorité Architecture ; jusqu'alors il ne fait pas foi.

## ADR attendus (non rédigés — ne pas inventer)

| Sujet | Déclencheur |
|-------|-------------|
| Statut/emplacement du kit + extension du workflow + PRR allégée | proposition ci-jointe |
| Entité trajet / kilométrage (Vehicles V2) | validation de la spec V2 |
| Protection de `db:push` / `db:reset` | décision utilisateur |
| Restriction de TEAM_LEADER sur Vehicles | décision utilisateur |
| Helper central d'isolation tenant | résultat de l'audit T1 |
