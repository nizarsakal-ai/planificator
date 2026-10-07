# Domaine — Employees

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** pour l'inventaire ; règles métier **À AUDITER**.

| Élément | Constat |
|---------|---------|
| Modèle | `Employee` ; lié à `User`, `Team`/`TeamMember`, `Assignment`/`EmployeeAssignment`, `Absence`, `Timeclock`, `TruckAssignment` (chauffeur) |
| Page | `/employes`, `/mes-absences`, `/pointage`, `/pointages` |
| Code | `src/lib/employes/employes-view.ts`, `src/lib/actions/employe.actions.ts`, `employe-delete.core.ts`, `invitation-*.core.ts` |
| Tests | `tests/employes/` : vue opérationnelle, rendu, suppression (`employee-delete-v1b-db`), réactivation d'invitation ; `tests/security/plan-security-hotfix-001.test.ts` couvre `deleteEmploye` et invitations |
| Commits récents | `059755e` feat(employees): add operational employee view (#64) |

## Règles liées à Vehicles (vérifiées)

- Un employé référencé par l'historique d'un véhicule **ne peut pas être supprimé** (FK RESTRICT) ; le code V1B-db refuse proprement avant la FK.
- Un chauffeur `active = false` ne peut pas recevoir de nouvelle affectation véhicule (`DRIVER_INACTIVE`).

## À AUDITER

Modèle de désactivation vs suppression ; règles d'invitation et de rôle ; lien `User`↔`Employee` ; données personnelles (RGPD).
