/**
 * Santé de la connexion Gmail Booking, dérivée sans nouvelle colonne.
 *
 * Incident 29/10 → 16/11/2026 : le jeton Google de la boîte Booking était révoqué
 * (`invalid_grant`) mais le cadre Paramètres affichait « Connecté » : aucune
 * réservation n'arrivait, sans aucun signal.
 *
 * Principe : le scan horaire (`/api/cron/gmail-scan`, `30 * * * *`) rafraîchit le
 * jeton d'accès (durée Google : 1 h) dès qu'il expire et écrit la nouvelle
 * `tokenExpiry`. Une connexion saine a donc toujours une `tokenExpiry` récente.
 * Une `tokenExpiry` dépassée depuis plus de deux passages signifie que Google
 * refuse le rafraîchissement : reconnexion requise.
 */

export type BookingGmailHealthLevel = "ok" | "error" | "inactive"

export interface BookingGmailHealth {
  level: BookingGmailHealthLevel
  label: string
  hint?: string
}

/** Deux passages horaires manqués + marge réseau / démarrage à froid. */
export const BOOKING_GMAIL_STALE_AFTER_MS = 2 * 60 * 60 * 1000 + 15 * 60 * 1000

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function assessBookingGmailHealth(input: {
  tokenExpiry: Date | string | null | undefined
  /** Kill-switch du scan (BOOKING_GMAIL_SCAN_ENABLED) : sans scan, aucun rafraîchissement attendu. */
  scanEnabled: boolean
  now?: Date
}): BookingGmailHealth {
  if (!input.scanEnabled) {
    return {
      level: "inactive",
      label: "synchronisation désactivée",
      hint: "Le scan automatique des réservations Booking est désactivé sur ce serveur.",
    }
  }
  const now = input.now ?? new Date()
  const expiry = toDate(input.tokenExpiry)
  if (expiry && now.getTime() - expiry.getTime() > BOOKING_GMAIL_STALE_AFTER_MS) {
    return {
      level: "error",
      label: "reconnexion requise",
      hint:
        "Google refuse l'accès à cette boîte : aucune réservation n'est importée. " +
        "Cliquez sur « Reconnecter Gmail », choisissez ce compte et cochez « Lire vos e-mails ».",
    }
  }
  return { level: "ok", label: "synchronisée toutes les heures" }
}
