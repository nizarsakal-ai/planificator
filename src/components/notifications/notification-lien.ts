// Destination d'une notification au clic : le lien enregistré s'il est interne, sinon la page de la catégorie.
// Seuls les chemins relatifs à l'application sont suivis (jamais d'URL externe, ni « //hôte » ni « /\hôte »).

const PAGE_PAR_TYPE: Record<string, string> = {
  ASSIGNMENT_CREATED: "/planning",
  ASSIGNMENT_CONFIRMED: "/planning",
  ASSIGNMENT_REFUSED: "/planning",
  WORKSITE_UPDATED: "/chantiers",
  WORKSITE_ARCHIVED: "/chantiers",
  WORKSITE_EXTENDED: "/chantiers",
  INVITATION_SENT: "/employes",
  ABSENCE_REQUESTED: "/absences",
  ABSENCE_APPROVED: "/mes-absences",
  ABSENCE_REJECTED: "/mes-absences",
  EXPENSE_SUBMITTED: "/notes-de-frais",
  EXPENSE_APPROVED: "/mes-notes-de-frais",
  EXPENSE_REJECTED: "/mes-notes-de-frais",
  TIMECLOCK_IN: "/pointages",
  TIMECLOCK_OUT: "/pointages",
  ACCOMMODATION_CREATED: "/logements",
  ACCOMMODATION_CANCELLED: "/logements",
  BOOKING_DETECTED: "/logements",
  VEHICLE_DOCUMENT_EXPIRING: "/vehicules",
  VEHICLE_DOCUMENT_EXPIRED: "/vehicules",
  WORKSITE_PHOTO_UNSENT: "/photos-engins",
  AUTOMATION: "/automatisations",
}

export function lienInterne(lien: string | null | undefined): string | null {
  if (typeof lien !== "string") return null
  const l = lien.trim()
  if (!l.startsWith("/") || l.startsWith("//") || l.startsWith("/\\")) return null
  return l
}

export function destinationNotification(n: { link?: string | null; type: string }): string | null {
  return lienInterne(n.link) ?? PAGE_PAR_TYPE[n.type] ?? null
}
