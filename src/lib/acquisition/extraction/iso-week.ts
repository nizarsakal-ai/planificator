/**
 * PLAN-ACQ-CONSULTATIONS-FIX-001 — Conversion déterministe ISO-8601 week → plage.
 * Lundi → dimanche (UTC date-only). Aucune invention IA.
 */

export type IsoWeekRange = {
  startDate: string // YYYY-MM-DD
  endDate: string
}

/** Nombre de semaines ISO dans une année (52 ou 53). */
export function isoWeeksInYear(year: number): number {
  // La semaine du 28 décembre détermine s’il y a 53 semaines.
  const d = new Date(Date.UTC(year, 11, 28))
  return isoWeekNumber(d)
}

function isoWeekNumber(date: Date): number {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  )
  // Jeudi de la semaine courante
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
}

/** Lundi UTC de la semaine ISO `week` de `year`. */
export function isoWeekMonday(year: number, week: number): Date | null {
  if (!Number.isInteger(year) || year < 1970 || year > 2100) return null
  if (!Number.isInteger(week) || week < 1 || week > 53) return null
  const max = isoWeeksInYear(year)
  if (week > max) return null

  // 4 janvier est toujours en semaine ISO 1
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const day = jan4.getUTCDay() || 7 // 1=Mon … 7=Sun
  const mondayWeek1 = new Date(jan4)
  mondayWeek1.setUTCDate(jan4.getUTCDate() - (day - 1))

  const monday = new Date(mondayWeek1)
  monday.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7)
  return monday
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Plage lundi→dimanche pour une semaine ISO valide.
 * Retourne null si semaine/année invalides.
 */
export function isoWeekToDateRange(
  weekNumber: number,
  weekYear: number
): IsoWeekRange | null {
  const monday = isoWeekMonday(weekYear, weekNumber)
  if (!monday) return null
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  return { startDate: toYmd(monday), endDate: toYmd(sunday) }
}

/** FIX-002B — rétrospection courte (≤ 2 semaines ISO). */
export const ISO_WEEK_YEAR_RETRO_MAX_DAYS = 14
/** FIX-002B — prospectif borné (décision métier validée). */
export const ISO_WEEK_YEAR_PROSPECTIVE_MAX_DAYS = 56

const MS_PER_DAY = 86_400_000

type IsoWeekYearRelation =
  | { kind: "CONTAINING"; year: number }
  | { kind: "PAST"; year: number; daysSinceEnd: number }
  | { kind: "FUTURE"; year: number; daysUntilStart: number }

function classifyIsoWeekYearCandidate(
  referenceDate: Date,
  year: number,
  range: IsoWeekRange
): IsoWeekYearRelation | null {
  const startMs = Date.parse(`${range.startDate}T00:00:00.000Z`)
  const endMs = Date.parse(`${range.endDate}T23:59:59.999Z`)
  const t = referenceDate.getTime()
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || Number.isNaN(t)) return null
  if (t >= startMs && t <= endMs) return { kind: "CONTAINING", year }
  if (t > endMs) {
    return { kind: "PAST", year, daysSinceEnd: (t - endMs) / MS_PER_DAY }
  }
  return { kind: "FUTURE", year, daysUntilStart: (startMs - t) / MS_PER_DAY }
}

/**
 * PLAN-ACQ-CONSULTATIONS-FIX-002B — Résout l’année ISO d’une semaine W
 * depuis receivedAt, fail-closed (pas de « nearest always »).
 *
 * Candidats calendarYear±1 via isoWeekToDateRange (S53 hors année 52 exclus).
 * Acceptation : CONTAINING, sinon PAST avec 0 < daysSinceEnd ≤ 14,
 * sinon FUTURE avec 0 < daysUntilStart ≤ 56 ; unicité obligatoire.
 * Ne mute pas `referenceDate`. UTC uniquement. Pas d’horloge d’exécution.
 */
export function resolveIsoWeekYearFromReferenceDate(
  weekNumber: number,
  referenceDate: Date
): number | null {
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 53) return null
  if (!(referenceDate instanceof Date) || Number.isNaN(referenceDate.getTime())) return null

  // Snapshot UTC — ne jamais muter l’argument.
  const ref = new Date(referenceDate.getTime())
  const calendarYear = ref.getUTCFullYear()
  if (calendarYear < 1970 || calendarYear > 2100) return null

  const relations: IsoWeekYearRelation[] = []
  for (const year of [calendarYear - 1, calendarYear, calendarYear + 1]) {
    const range = isoWeekToDateRange(weekNumber, year)
    if (!range) continue
    const rel = classifyIsoWeekYearCandidate(ref, year, range)
    if (rel) relations.push(rel)
  }

  if (relations.length === 0) return null

  const containing = relations.filter((r) => r.kind === "CONTAINING")
  if (containing.length === 1) return containing[0]!.year
  if (containing.length > 1) return null

  const admissible: number[] = []
  for (const r of relations) {
    if (
      r.kind === "PAST" &&
      r.daysSinceEnd > 0 &&
      r.daysSinceEnd <= ISO_WEEK_YEAR_RETRO_MAX_DAYS
    ) {
      admissible.push(r.year)
    } else if (
      r.kind === "FUTURE" &&
      r.daysUntilStart > 0 &&
      r.daysUntilStart <= ISO_WEEK_YEAR_PROSPECTIVE_MAX_DAYS
    ) {
      admissible.push(r.year)
    }
  }

  if (admissible.length === 1) return admissible[0]!
  return null
}
