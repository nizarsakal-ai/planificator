// ═══════════════════════════════════════════════════════════════════════════
// Validité métier d'un devis (correctif P2-04). `validUntil` est une DATE CIVILE (stockée à minuit UTC du jour choisi).
// Règle : le devis est valable jusqu'au DERNIER INSTANT de ce jour civil en Europe/Paris (fuseau de l'entreprise) ;
// la fin de validité est le premier instant du lendemain (borne EXCLUE), calculée avec le décalage réel (heure d'été/hiver).
// Sans `validUntil`, aucune validité métier : seule l'expiration technique du jeton (30 jours) s'applique.
// La décision (envoi, renvoi, signature, refus par lien) est prise à l'instant de la requête, jamais déléguée à un cron.
// ═══════════════════════════════════════════════════════════════════════════
export const QUOTE_VALIDITY_TIMEZONE = "Europe/Paris"

/** Décalage (ms) entre l'heure murale du fuseau et UTC, à un instant donné (positif à l'est de Greenwich). */
export function timeZoneOffsetMs(instant: Date, timeZone: string = QUOTE_VALIDITY_TIMEZONE): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  const p: Record<string, number> = {}
  for (const part of dtf.formatToParts(instant)) if (part.type !== "literal") p[part.type] = Number(part.value)
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
  return wall - Math.floor(instant.getTime() / 1000) * 1000
}

/** Premier instant (UTC) du jour civil suivant `validUntil` en Europe/Paris : le devis est valable strictement AVANT cet instant. */
export function quoteValidityEnd(validUntil: Date, timeZone: string = QUOTE_VALIDITY_TIMEZONE): Date {
  const nextDayWall = Date.UTC(validUntil.getUTCFullYear(), validUntil.getUTCMonth(), validUntil.getUTCDate() + 1)
  // instant = heure murale − décalage ; deux itérations pour converger à travers un changement d'heure.
  let instant = new Date(nextDayWall - timeZoneOffsetMs(new Date(nextDayWall), timeZone))
  instant = new Date(nextDayWall - timeZoneOffsetMs(instant, timeZone))
  return instant
}

/** Validité métier à l'instant `now` : sans validUntil ⇒ valable ; sinon now < fin de validité. */
export function isQuoteValidAt(validUntil: Date | null | undefined, now: Date): boolean {
  return !validUntil || now.getTime() < quoteValidityEnd(validUntil).getTime()
}

/** Jour civil (Europe/Paris) d'un instant, représenté comme `validUntil` (minuit UTC) : un devis est périmé ⇔ validUntil < ce jour. */
export function calendarDayIn(now: Date, timeZone: string = QUOTE_VALIDITY_TIMEZONE): Date {
  const wall = new Date(now.getTime() + timeZoneOffsetMs(now, timeZone))
  return new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()))
}

export const QUOTE_EXPIRED_MESSAGE = "La validité de ce devis est dépassée : il ne peut plus être envoyé ni signé. Dupliquez-le pour renouveler explicitement l'offre."
