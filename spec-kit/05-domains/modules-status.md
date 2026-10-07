# État des modules

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** pour ce qui est mergé dans `origin/main` (e707381, 2026-10-07). **Aucun état RELEASED ou CLOSED n'a été vérifié** : cela demande des preuves de déploiement et de PRR que cet audit n'a pas.

Vocabulaire : états ES-001 §5.1 — PROPOSED, SPECIFIED, IN_BUILD, IN_REVIEW, RELEASED, CLOSED, DEPRECATED, RETIRED. « Mergé », « COMPLETE » et « PLANNED » ne sont pas des états : un merge seul laisse le module IN_REVIEW (PLAN-GOVERNANCE-001).

```
Vehicles
├── V0   API hardening          IN_REVIEW (merge seul, b37cc8d)   RELEASED/CLOSED : à confirmer
├── V1A  foundation DB          IN_REVIEW (merge seul, 927084a)   RELEASED/CLOSED : à confirmer
├── V1B  archive/history        IN_REVIEW (merge seul, a6eff84)   RELEASED/CLOSED : à confirmer
├── V1B-db historical integrity IN_REVIEW (merge seul, b57a017)   RELEASED/CLOSED : à confirmer
├── V1C  identity + fleet UI    IN_REVIEW (merge seul, e707381)   RELEASED/CLOSED : à confirmer
├── V2   mileage                PROPOSED          spec rédigée, non validée
└── V3   maintenance / CT       PROPOSED          idée seulement, aucune spec
```

| Domaine | Présent dans origin/main | Tests | Doc de spec | Remarque |
|---------|------------------------|-------|-------------|----------|
| Vehicles | V0 → V1C | oui (unitaires, pas de pg) | ce kit | voir `vehicles.md` ; état **IN_REVIEW (merge seul)** |
| Teams | `6c1c0d8` redesign | oui | — | branche `feat/equipes-v2-core` non mergée (à confirmer) |
| Employees | `059755e` vue opérationnelle | oui | — | |
| Worksites | `0b17a37` vue/filtres | oui | — | |
| Navigation | `63bc6d4`, `d2695fd` | oui | — | travail en cours hors main |
| Acquisition | nombreux lots | très nombreux | `docs/plan-acq-012-*` | état des lots à confirmer |
| Booking | oui | oui (dont pg) | `BOOKING-INVARIANTS.md` | |
| Integration platform | lots **1A, 1B, 1B2, 1C** ; **LOT-2 : spec seule** (`0dfc0ca`), implémentation (`6400e4e`, `814c3f6`) non mergée | oui (dont pg) | `docs/integration-platform-001*` | pas de routeur dans `src/lib/integration/` (seuls des contrats et types du LOT-1A, ex. `contracts/routing-decision.ts`) |
| Planning | existant | **aucun dossier `tests/planning/`** ; seul `tests/chantiers/assignment-ui-policy.test.ts` touche aux affectations | aucune | à auditer en priorité |
| Finance | existant | **aucun** | aucune | à auditer en priorité |
| Absences / Pointage / Logements | existant | `tests/absences/create-absence-formdata.test.ts` ; pas de dossier dédié pointage/logements (la création d'`Accommodation` est couverte indirectement par `tests/booking/*`) | aucune | à auditer |

## Règle de mise à jour

Un module passe à RELEASED seulement avec la preuve de son déploiement dans l'environnement cible, et à CLOSED seulement avec la PRR et les critères ES-001 §26. Cette page est mise à jour **dans la même PR** que le changement d'état.
