/**
 * Cutoff de scan Booking (gmail-scan) — configurable, fail-soft.
 * Variable : `BOOKING_SCAN_CUTOFF_DATE` (YYYY-MM-DD strict, calendrier réel, UTC).
 * Absente / invalide → 2026-06-17 (comportement historique).
 */

export const BOOKING_SCAN_CUTOFF_DEFAULT_YMD = "2026-06-17"

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function utcDateFromYmdParts(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day))
}

function parseStrictUtcYmd(ymd: string): Date | null {
  const m = YMD_RE.exec(ymd)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const dt = utcDateFromYmdParts(year, month, day)
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
 * Date de bascule (UTC minuit) : réservations avec startDate strictement antérieure
 * sont `PERMANENTLY_IGNORED` / `BEFORE_CUTOFF_DATE`.
 * Ne throw pas ; ne mute pas `process.env`.
 */
export function getBookingScanCutoffDate(
  env: NodeJS.ProcessEnv = process.env
): Date {
  const raw = env.BOOKING_SCAN_CUTOFF_DATE
  if (raw === undefined) {
    return parseStrictUtcYmd(BOOKING_SCAN_CUTOFF_DEFAULT_YMD)!
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    return parseStrictUtcYmd(BOOKING_SCAN_CUTOFF_DEFAULT_YMD)!
  }
  return parseStrictUtcYmd(trimmed) ?? parseStrictUtcYmd(BOOKING_SCAN_CUTOFF_DEFAULT_YMD)!
}
