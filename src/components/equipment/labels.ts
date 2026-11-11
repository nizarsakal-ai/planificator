// Lot B : libellés et pastilles du matériel (classes de couleur déjà présentes dans l'application, mêmes tons que le lot A).
export const EQUIPMENT_STATUS_LABEL: Record<string, string> = { AVAILABLE: "Disponible", OUT: "Sorti", MAINTENANCE: "En entretien", RETIRED: "Réformé" }
export const EQUIPMENT_STATUS_CLASS: Record<string, string> = {
  AVAILABLE: "bg-green-50 text-green-700", OUT: "bg-blue-50 text-blue-700", MAINTENANCE: "bg-amber-50 text-amber-700", RETIRED: "bg-slate-100 text-slate-700",
}
export const CONDITION_LABEL: Record<string, string> = { GOOD: "Bon état", WORN: "Usé", DAMAGED: "Endommagé" }
export const OWNERSHIP_LABEL: Record<string, string> = { OWNED: "Propriété", RENTED: "Loué" }
export const BOOKING_STATUS_LABEL: Record<string, string> = { RESERVED: "Réservé", CHECKED_OUT: "Sorti", RETURNED: "Rendu", CANCELLED: "Annulé" }
export const BOOKING_STATUS_CLASS: Record<string, string> = {
  RESERVED: "bg-slate-100 text-slate-700", CHECKED_OUT: "bg-blue-50 text-blue-700", RETURNED: "bg-green-50 text-green-700", CANCELLED: "bg-red-50 text-red-600",
}
export const RENTAL_STATUS_LABEL: Record<string, string> = { ACTIVE: "En cours", CLOSED: "Clôturé", CANCELLED: "Annulé" }
export const RENTAL_STATUS_CLASS: Record<string, string> = { ACTIVE: "bg-blue-50 text-blue-700", CLOSED: "bg-green-50 text-green-700", CANCELLED: "bg-red-50 text-red-600" }

const dayFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
/** Jour (minuit UTC) au format français. */
export const fmtDay = (d: Date) => dayFr.format(d)
const instantFr = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })
/** Instant (sortie, retour) en heure de Paris ; les jours de réservation et de contrat restent des jours (UTC). */
export const fmtInstant = (d: Date) => instantFr.format(d)
/** Dernier jour inclus d'une réservation stockée en intervalle semi-ouvert [début, fin). */
export const lastDayOf = (endAt: Date) => dayFr.format(new Date(endAt.getTime() - 86_400_000))
