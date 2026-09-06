/**
 * PLAN-ACQ-CONSULTATION-TEMPORAL-POLICY — classification période de prestation.
 * Comparaison calendaire : dates chantier = YMD UTC stockés ; today = Europe/Paris.
 */

export const WORK_PERIOD_CLASSIFICATIONS = [
  "FUTURE",
  "ACTIVE",
  "OBSOLETE",
  "UNKNOWN_DATES",
  "INVALID",
] as const

export type WorkPeriodClassification = (typeof WORK_PERIOD_CLASSIFICATIONS)[number]

export const ACQUISITION_BUSINESS_TIMEZONE = "Europe/Paris" as const

/** YMD calendaire d’une Date stockée comme jour métier (T00:00:00.000Z). */
export function dateToUtcCalendarYmd(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** Jour calendaire Europe/Paris pour un instant donné. */
export function instantToParisCalendarYmd(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ACQUISITION_BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant)
}

/**
 * Classification déterministe de la plage de prestation.
 * @param referenceInstant — injecter en tests ; défaut Date.now() uniquement hors tests.
 */
export function classifyWorkPeriod(
  start: Date | null | undefined,
  end: Date | null | undefined,
  referenceInstant: Date = new Date()
): WorkPeriodClassification {
  const hasStart = start != null
  const hasEnd = end != null
  if (!hasStart && !hasEnd) return "UNKNOWN_DATES"
  if (hasStart !== hasEnd) return "INVALID"

  const startYmd = dateToUtcCalendarYmd(start!)
  const endYmd = dateToUtcCalendarYmd(end!)
  if (startYmd > endYmd) return "INVALID"

  const todayYmd = instantToParisCalendarYmd(referenceInstant)
  if (endYmd < todayYmd) return "OBSOLETE"
  if (startYmd > todayYmd) return "FUTURE"
  return "ACTIVE"
}

export function isWorkPeriodObsolete(
  start: Date | null | undefined,
  end: Date | null | undefined,
  referenceInstant?: Date
): boolean {
  return classifyWorkPeriod(start, end, referenceInstant) === "OBSOLETE"
}
