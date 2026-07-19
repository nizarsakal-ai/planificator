/**
 * Politique d'affichage du formulaire « Affecter une équipe » (page détail chantier).
 *
 * Règle métier :
 * - ADMIN / SUPER_ADMIN : visible sauf chantier ARCHIVED
 * - COMPLETED reste affectable : le cron peut passer IN_PROGRESS → COMPLETED
 *   dès que endDate < aujourd'hui ; une date de fin passée ne doit pas
 *   empêcher la correction / réaffectation administrative
 * - TEAM_LEADER / EMPLOYEE : masqué (politique historique de la page détail)
 * - L'absence d'affectations n'a aucun effet sur la visibilité
 */
export function canShowAffecterEquipeForm(input: {
  role: string | null | undefined
  status: string
}): boolean {
  const isAdmin = input.role === "ADMIN" || input.role === "SUPER_ADMIN"
  if (!isAdmin) return false
  if (input.status === "ARCHIVED") return false
  return true
}
