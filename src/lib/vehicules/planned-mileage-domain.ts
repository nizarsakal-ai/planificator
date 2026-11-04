/**
 * Kilométrage prévu par chantier : règle pure, sans réseau ni base.
 * Camion → équipe (période d'affectation couvrant le jour) → planning → chantier.
 * Une estimation par chantier et par mois : aller-retour depuis le siège + marge fixe.
 * Jamais écrite dans le journal du compteur.
 */
import { MileageDomainError } from "./mileage-domain"

export const PLANNED_MILEAGE_FLAG = "PLANIFICATOR_VEHICLE_PLANNED_MILEAGE_ENABLED"
export const PLANNED_MILEAGE_MARGIN_KM = 200
/** Facteur de détour appliqué à la distance à vol d'oiseau quand l'itinéraire est indisponible. */
export const CROW_FLIGHT_DETOUR_FACTOR = 1.3
/** Point de départ demandé par Nizar : siège, Montreuil centre (centroïde IGN de la commune 93048). */
export const PLANNED_MILEAGE_DEPOT = { label: "Siège · Montreuil centre", latitude: 48.863728, longitude: 2.449364 } as const
/** Seule société dont le point de départ est connu : GALYA EVENTS. Les autres sont refusées, jamais estimées depuis Montreuil. */
export const PLANNED_MILEAGE_DEPOT_COMPANY_IDS: readonly string[] = ["cmvl0yv6q000ye4yjxs2mggy8"]

export function hasPlannedMileageDepot(companyId: string): boolean {
  return PLANNED_MILEAGE_DEPOT_COMPANY_IDS.includes(companyId)
}

export function isPlannedMileageEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[PLANNED_MILEAGE_FLAG]?.trim() === "true"
}

/** `start`/`end` : minuit UTC des colonnes DATE ; `parisStart`/`parisEnd` : instants de minuit à Paris (horodatages). */
export interface PlannedPeriod { month: string; start: Date; end: Date; parisStart: Date; parisEnd: Date }

/** Mois civil « AAAA-MM » ; par défaut le mois en cours à Paris. */
export function parsePlannedMonth(raw: string | null | undefined, now = new Date()): PlannedPeriod {
  const value = raw?.trim() || parisDay(now).slice(0, 7)
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value)
  if (!match) throw new MileageDomainError("INVALID_MONTH", 400)
  const year = Number(match[1]), month = Number(match[2])
  if (year < 2000 || year > 2100) throw new MileageDomainError("INVALID_MONTH", 400)
  return {
    month: value, start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)),
    parisStart: parisMidnight(year, month - 1, 1), parisEnd: parisMidnight(year, month, 1),
  }
}

/** Écart Paris − UTC en minutes à un instant donné (heure d'hiver 60, d'été 120). */
function parisOffsetMinutes(instant: Date): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant).map((part) => [part.type, part.value]))
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  return Math.round((asUtc - instant.getTime()) / 60_000)
}

/** Instant UTC de minuit à Paris (mois 0-11, débordement accepté comme Date.UTC). */
export function parisMidnight(year: number, monthIndex: number, day: number): Date {
  const utcMidnight = Date.UTC(year, monthIndex, day)
  const guess = utcMidnight - parisOffsetMinutes(new Date(utcMidnight)) * 60_000
  return new Date(utcMidnight - parisOffsetMinutes(new Date(guess)) * 60_000)
}

/** Jour civil parisien « AAAA-MM-JJ » d'un instant. */
export function parisDay(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant)
}

export interface TruckTeamPeriod { teamId: string | null; startedAt: Date; endedAt: Date | null }
export interface PlannedWorksite { id: string; name: string; address: string | null; latitude: number | null; longitude: number | null }
export interface PlannedAssignment { date: Date; teamId: string; worksite: PlannedWorksite }
export interface PlannedWorksiteDays { worksite: PlannedWorksite; days: string[] }

/**
 * Garde chaque jour de planning dont l'équipe avait le camion ce jour-là (bornes incluses :
 * le jour d'une réaffectation compte pour les deux équipes), puis regroupe par chantier.
 */
export function resolvePlannedWorksites(assignments: PlannedAssignment[], periods: TruckTeamPeriod[]): PlannedWorksiteDays[] {
  const windows = periods.filter((p) => p.teamId).map((p) => ({
    teamId: p.teamId!, from: parisDay(p.startedAt), to: p.endedAt ? parisDay(p.endedAt) : null,
  }))
  const byWorksite = new Map<string, { worksite: PlannedWorksite; days: Set<string> }>()
  for (const assignment of assignments) {
    // Colonne DATE : minuit UTC représente directement le jour civil.
    const day = assignment.date.toISOString().slice(0, 10)
    const covered = windows.some((w) => w.teamId === assignment.teamId && w.from <= day && (w.to === null || w.to >= day))
    if (!covered) continue
    const group = byWorksite.get(assignment.worksite.id) ?? { worksite: assignment.worksite, days: new Set<string>() }
    group.days.add(day)
    byWorksite.set(assignment.worksite.id, group)
  }
  return [...byWorksite.values()]
    .map(({ worksite, days }) => ({ worksite, days: [...days].sort() }))
    .sort((a, b) => a.days[0].localeCompare(b.days[0]) || a.worksite.name.localeCompare(b.worksite.name, "fr"))
}

export interface Point { latitude: number; longitude: number }

export function crowFlightKm(a: Point, b: Point): number {
  const rad = Math.PI / 180
  const h = Math.sin((b.latitude - a.latitude) * rad / 2) ** 2
    + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin((b.longitude - a.longitude) * rad / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)))
}

export type DistanceSource = "ROUTE" | "ESTIMATE"

/** Aller-retour arrondi au kilomètre, puis marge fixe ajoutée à chaque calcul. */
export function plannedTripKm(oneWayKm: number) {
  if (!Number.isFinite(oneWayKm) || oneWayKm < 0) throw new MileageDomainError("INVALID_ROUTE_DISTANCE", 502)
  const roundTripKm = Math.round(oneWayKm * 2)
  return { roundTripKm, marginKm: PLANNED_MILEAGE_MARGIN_KM, totalKm: roundTripKm + PLANNED_MILEAGE_MARGIN_KM }
}
