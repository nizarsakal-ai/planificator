# Domaine — Planning

> Audience : agents IA, contributeurs, architecture · Statut : Draft (ES-001 §20.4)

Statut : **VÉRIFIÉ** pour l'inventaire minimal ; **À AUDITER** pour tout le reste. **Aucun test dans `tests/planning/` (dossier inexistant).**

| Élément | Constat |
|---------|---------|
| Modèles | `Assignment`, `EmployeeAssignment`, `Absence` (liées à `Team`, `Worksite`, `Employee`) |
| Page | `/planning` ; composants `src/components/planning/` (10 fichiers) ; calendrier `react-big-calendar` |
| Actions | `src/lib/actions/assignment.actions.ts`, `absence.actions.ts` |
| Export | `/api/export/affectations` |
| Statuts | `AssignmentStatus` (valeurs À AUDITER) |
| Tests | Aucun test dédié au planning ; `tests/absences/create-absence-formdata.test.ts` ; `tests/chantiers/assignment-ui-policy.test.ts` |

## À AUDITER (priorité haute : domaine central sans tests)

Règles de conflit d'affectation (double réservation employé / équipe), isolation tenant des actions, règles de confirmation/refus par TEAM_LEADER, interaction avec les absences et les chantiers.
