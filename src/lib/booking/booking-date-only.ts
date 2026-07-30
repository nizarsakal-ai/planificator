/**
 * Dates métier Booking (champs Prisma `@db.Date`) — calendrier sans heure.
 * Représentation persistée : Date UTC minuit du jour civil YYYY-MM-DD.
 */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** Construit une Date UTC minuit si le triple (y,m,d) est un jour calendaire réel. */
export function utcDateFromCalendarParts(
  year: number,
  month: number,
  day: number
): Date | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null
  }
  const dt = new Date(Date.UTC(year, month - 1, day))
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null
  }
  return dt
}

/**
 * Parse strict `YYYY-MM-DD` → Date UTC minuit, ou null si format/calendrier invalide.
 * Ne laisse jamais `Date` normaliser silencieusement (ex. 2026-02-30).
 */
export function parseStrictCalendarYmd(ymd: string): Date | null {
  const m = YMD_RE.exec(ymd.trim())
  if (!m) return null
  return utcDateFromCalendarParts(Number(m[1]), Number(m[2]), Number(m[3]))
}

/**
 * Affiche / serialise une date métier pour `<input type="date">`.
 * - string déjà `YYYY-MM-DD` valide → inchangée
 * - `Date` (Prisma `@db.Date`) → composantes **UTC** (jour civil stocké)
 * - ISO avec heure → jour civil UTC
 * Ne pas utiliser pour `createdAt` / timestamps réels.
 */
export function formatDateOnlyForInput(
  value: Date | string | null | undefined
): string {
  if (value == null) return ""
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (YMD_RE.test(trimmed) && parseStrictCalendarYmd(trimmed)) {
      return trimmed.slice(0, 10)
    }
    const d = new Date(trimmed)
    if (Number.isNaN(d.getTime())) return ""
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  }
  if (Number.isNaN(value.getTime())) return ""
  return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`
}

/** true si end >= start (même jour autorisé), les deux non null. */
export function isCalendarRangeValid(start: Date, end: Date): boolean {
  return end.getTime() >= start.getTime()
}
