/**
 * Véhicule et chauffeur d'un chantier, dérivés des données existantes (aucune table nouvelle) :
 *   chantier → affectations (équipe, jour) → véhicule de l'équipe (Truck.teamId, unique)
 *   → chauffeur du véhicule (Truck.chauffeurId).
 *
 * Sert aussi à préparer la tournée du véhicule (`/vehicules/{id}/tournees`) : la tournée
 * reprend l'équipe et le chauffeur actuels du camion, avec le chantier comme étape.
 */

import { TOUR_MAX_DURATION_DAYS } from "@/lib/vehicules/v3/tour-domain"

/**
 * Jours civils proposés pour une tournée (07:00 le premier jour → 19:00 le dernier) :
 * N jours = (N − 1) j + 12 h ≤ durée maximale, donc N = durée maximale en jours.
 */
export const TOUR_MAX_DAYS = TOUR_MAX_DURATION_DAYS

export interface WorksiteAssignmentDay {
  teamId: string
  teamName: string
  /** Jour d'affectation (colonne @db.Date, minuit UTC). */
  date: Date
}

export interface TeamTruck {
  id: string
  matricule: string
  marque: string | null
  modele: string | null
  teamId: string
  chauffeurName: string | null
}

export interface WorksiteTeamVehicle {
  teamId: string
  teamName: string
  /** Premier et dernier jour retenus (à venir si possible, sinon les plus récents). */
  firstDate: string
  lastDate: string
  upcoming: boolean
  truck: {
    id: string
    matricule: string
    label: string
    chauffeurName: string | null
  } | null
  /** Fenêtre proposée pour la tournée (≤ TOUR_MAX_DAYS jours), au format YYYY-MM-DD. */
  tourStart: string
  tourEnd: string
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return isoDay(d)
}

export function worksiteTeamVehicles(input: {
  assignments: WorksiteAssignmentDay[]
  trucks: TeamTruck[]
  /** Aujourd'hui (jour civil, YYYY-MM-DD). */
  today: string
}): WorksiteTeamVehicle[] {
  const byTeam = new Map<string, { teamName: string; days: Set<string> }>()
  for (const a of input.assignments) {
    const entry = byTeam.get(a.teamId) ?? { teamName: a.teamName, days: new Set<string>() }
    entry.days.add(isoDay(a.date))
    byTeam.set(a.teamId, entry)
  }
  const truckByTeam = new Map(input.trucks.map((t) => [t.teamId, t]))

  const rows: WorksiteTeamVehicle[] = []
  for (const [teamId, { teamName, days }] of byTeam) {
    const sorted = [...days].sort()
    const future = sorted.filter((d) => d >= input.today)
    const kept = future.length > 0 ? future : sorted
    const firstDate = kept[0]
    const lastDate = kept[kept.length - 1]
    const maxEnd = addDays(firstDate, TOUR_MAX_DAYS - 1)
    const truck = truckByTeam.get(teamId)
    rows.push({
      teamId,
      teamName,
      firstDate,
      lastDate,
      upcoming: future.length > 0,
      truck: truck
        ? {
            id: truck.id,
            matricule: truck.matricule,
            label: [truck.marque, truck.modele].filter((x) => x && x.trim()).join(" ") || "Véhicule",
            chauffeurName: truck.chauffeurName,
          }
        : null,
      tourStart: firstDate,
      tourEnd: lastDate < maxEnd ? lastDate : maxEnd,
    })
  }
  // Équipes à venir d'abord, puis par date.
  return rows.sort((a, b) =>
    a.upcoming === b.upcoming ? a.firstDate.localeCompare(b.firstDate) : a.upcoming ? -1 : 1
  )
}

/** Lien vers la préparation de la tournée du véhicule, chantier pré-rempli. */
export function worksiteTourHref(input: {
  truckId: string
  worksiteId: string
  start: string
  end: string
}): string {
  const q = new URLSearchParams({ worksiteId: input.worksiteId, start: input.start, end: input.end })
  return `/vehicules/${encodeURIComponent(input.truckId)}/tournees?${q.toString()}`
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** Lecture défensive des paramètres de pré-remplissage de la page Tournées. */
export function parseTourPrefill(query: {
  worksiteId?: string | string[]
  start?: string | string[]
  end?: string | string[]
}): { worksiteId: string; start: string; end: string } | null {
  const worksiteId = typeof query.worksiteId === "string" ? query.worksiteId.trim() : ""
  const start = typeof query.start === "string" ? query.start : ""
  const end = typeof query.end === "string" ? query.end : ""
  if (!worksiteId || worksiteId.length > 200 || !DAY_RE.test(start) || !DAY_RE.test(end)) return null
  if (end < start || end > addDays(start, TOUR_MAX_DAYS - 1)) return null
  return { worksiteId, start, end }
}

/** Véhicule proposé pour une équipe du chantier qui n'en a pas. */
export interface AssignableTruck {
  id: string
  matricule: string
  label: string
  chauffeurName: string | null
  /** Équipe actuelle du véhicule (null = libre). */
  team: { id: string; name: string } | null
  /** Le véhicule est rattaché à une AUTRE équipe portant le même nom (doublon d'équipe). */
  sameNameTeam: boolean
}

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ")

/**
 * Ordre de proposition : véhicule d'une équipe homonyme (cas typique d'une équipe en double), puis
 * véhicules libres, puis véhicules d'autres équipes (l'affectation les retire de leur équipe actuelle).
 */
export function assignableTrucksFor(teamName: string, trucks: readonly Omit<AssignableTruck, "sameNameTeam">[]): AssignableTruck[] {
  const target = norm(teamName)
  const rank = (t: AssignableTruck) => (t.sameNameTeam ? 0 : t.team === null ? 1 : 2)
  return trucks
    .map((t) => ({ ...t, sameNameTeam: t.team !== null && norm(t.team.name) === target }))
    .sort((a, b) => rank(a) - rank(b) || a.matricule.localeCompare(b.matricule, "fr"))
}
