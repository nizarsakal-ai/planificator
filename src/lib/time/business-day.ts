// ═══════════════════════════════════════════════════════════════════════════
// Jour métier Europe/Paris — module PUR et neutre (aucune dépendance facturation/comptabilité), partagé par la facturation
// (dates d'émission, séries annuelles, échéances) et la comptabilité (jour par défaut de saisie, exercice courant, FEC).
// Représentation : minuit UTC du jour civil Europe/Paris (convention des colonnes de date). Décalage réel (heure d'été/hiver) via Intl.
// ═══════════════════════════════════════════════════════════════════════════
export const BUSINESS_TIMEZONE = "Europe/Paris"

/** Décalage (ms) entre l'heure murale du fuseau et UTC, à un instant donné (positif à l'est de Greenwich). */
export function timeZoneOffsetMs(instant: Date, timeZone: string = BUSINESS_TIMEZONE): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  const p: Record<string, number> = {}
  for (const part of dtf.formatToParts(instant)) if (part.type !== "literal") p[part.type] = Number(part.value)
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
  return wall - Math.floor(instant.getTime() / 1000) * 1000
}

/** Jour civil Europe/Paris de l'instant, à minuit UTC. */
export function businessDay(instant: Date, timeZone: string = BUSINESS_TIMEZONE): Date {
  const wall = new Date(instant.getTime() + timeZoneOffsetMs(instant, timeZone))
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()))
}

/** Année civile Europe/Paris de l'instant (série annuelle des numéros). */
export function businessYear(instant: Date): number {
  return businessDay(instant).getUTCFullYear()
}

/** Ajoute `days` jours civils à une date-jour (minuit UTC) ; sans dérive de changement d'heure (arithmétique UTC sur des jours). */
export function addBusinessDays(day: Date, days: number): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + days))
}
