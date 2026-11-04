/**
 * Véhicules V3 — estimation carburant d'un trajet : règles pures (aucun réseau, aucune base), partageables côté navigateur.
 * Kilomètres : compteur du trajet clos, sinon aller-retour routier siège → chantier. Stations : celles du couloir du
 * trajet, prix publics du jour (flux instantané data.economie.gouv.fr). Consommation saisie par l'opérateur.
 * Une estimation n'est jamais un montant payé : la dépense reste « À valider » et le ticket réel prime.
 */
export const FUEL_ESTIMATE_FLAG = "PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED"

export function isFuelEstimateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[FUEL_ESTIMATE_FLAG]?.trim() === "true"
}

export const FUEL_TYPES = ["GAZOLE", "E10", "SP95", "SP98", "E85", "GPLC"] as const
export type FuelType = (typeof FUEL_TYPES)[number]
export const FUEL_LABELS: Record<FuelType, string> = { GAZOLE: "Gazole", E10: "SP95-E10", SP95: "SP95", SP98: "SP98", E85: "E85 (superéthanol)", GPLC: "GPL" }

export type Point = { latitude: number; longitude: number }
export type KmSource = "ODOMETER" | "ROUTE_ROUND_TRIP" | "STAY_ROUND_TRIP"
export type RouteStatus = "ROUTE" | "NO_DEPOT" | "NO_WORKSITE" | "ADDRESS_NOT_FOUND" | "UNAVAILABLE"
export type StationsStatus = "ROUTE_CORRIDOR" | "NEAR_WORKSITE" | "NEAR_DEPOT" | "NONE" | "UNAVAILABLE"

export interface FuelStation {
  id: string
  label: string
  city: string
  /** Prix au litre en euros, tel que publié. */
  price: number
  /** Date de mise à jour du prix publiée par la station (ISO). */
  updatedAt: string
  /** Écart au trajet, en kilomètres (0 = sur le trajet). */
  offRouteKm: number
  open24h: boolean
}

/** Séjour d'une équipe sur un chantier : départ le premier jour planifié, retour le dernier (jours consécutifs). */
export interface PlannedStay {
  /** `chantier~équipe~premier jour` : identifiant stable recalculé côté serveur. */
  id: string
  worksiteId: string
  worksiteName: string
  hasAddress: boolean
  teamId: string
  teamName: string | null
  leaderName: string | null
  chauffeurName: string | null
  /** Jour du départ (AAAA-MM-JJ). */
  departure: string
  /** Jour du retour (AAAA-MM-JJ). */
  return: string
  days: number
}

export interface PriceStats { count: number; min: number; median: number; max: number }

export interface FuelEstimate {
  /** Trajet relevé au compteur (`TRIP`) ou séjour planifié sur un chantier (`STAY`). */
  source: "TRIP" | "STAY"
  tripId: string
  stay: PlannedStay | null
  /** Jour du départ, dans le fuseau de l'entreprise (AAAA-MM-JJ). */
  tripDate: string
  tripClosed: boolean
  worksiteName: string | null
  /** Compteur à l'arrivée (trajet clos), sinon au départ. */
  odometer: number | null
  km: number | null
  kmSource: KmSource | null
  route: { status: RouteStatus; oneWayKm: number | null }
  fuel: FuelType
  stations: FuelStation[]
  stationsStatus: StationsStatus
  /** Prix sur l'ensemble des stations du couloir (les stations listées ne sont que les moins chères). */
  priceStats: PriceStats | null
}

// ─── Séjours planifiés ───────────────────────────────────────────────────────

export const STAY_ID = /^[A-Za-z0-9_-]{1,64}~[A-Za-z0-9_-]{1,64}~\d{4}-\d{2}-\d{2}$/

export interface StayAssignment { date: string; teamId: string; worksite: { id: string; name: string; address: string | null } }
export interface StayTruckPeriod { teamId: string | null; chauffeurId: string | null; from: string; to: string | null }

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/**
 * Séjours du camion : jours de planning dont l'équipe avait le camion ce jour-là, regroupés par chantier et équipe, puis
 * découpés en suites de jours consécutifs. Chaque suite = un départ (premier jour) et un retour (dernier jour).
 * Le chauffeur est celui de la période du camion qui couvre le jour du départ.
 */
export function resolveStays(assignments: readonly StayAssignment[], periods: readonly StayTruckPeriod[]): (Omit<PlannedStay, "teamName" | "leaderName" | "chauffeurName"> & { chauffeurId: string | null })[] {
  const covering = (teamId: string, day: string) => periods.find((p) => p.teamId === teamId && p.from <= day && (p.to === null || p.to >= day))
  const groups = new Map<string, { assignment: StayAssignment; days: Set<string> }>()
  for (const a of assignments) {
    if (!covering(a.teamId, a.date)) continue
    const key = `${a.worksite.id}~${a.teamId}`
    const group = groups.get(key) ?? { assignment: a, days: new Set<string>() }
    group.days.add(a.date)
    groups.set(key, group)
  }
  const stays: ReturnType<typeof resolveStays> = []
  for (const { assignment, days } of groups.values()) {
    const sorted = [...days].sort()
    let start = 0
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && sorted[i] === nextDay(sorted[i - 1])) continue
      const departure = sorted[start], back = sorted[i - 1]
      stays.push({
        id: `${assignment.worksite.id}~${assignment.teamId}~${departure}`, worksiteId: assignment.worksite.id, worksiteName: assignment.worksite.name,
        hasAddress: !!assignment.worksite.address?.trim(), teamId: assignment.teamId, departure, return: back, days: i - start,
        chauffeurId: covering(assignment.teamId, departure)?.chauffeurId ?? null,
      })
      start = i
    }
  }
  return stays.sort((a, b) => b.departure.localeCompare(a.departure) || a.worksiteName.localeCompare(b.worksiteName, "fr"))
}

export function priceStats(stations: readonly { price: number }[]): PriceStats | null {
  const prices = stations.map((s) => s.price).filter((p) => Number.isFinite(p)).sort((a, b) => a - b)
  if (!prices.length) return null
  const mid = prices.length / 2
  const median = prices.length % 2 ? prices[Math.floor(mid)] : (prices[mid - 1] + prices[mid]) / 2
  return { count: prices.length, min: prices[0], median: Math.round(median * 1000) / 1000, max: prices[prices.length - 1] }
}

// ─── Géométrie ───────────────────────────────────────────────────────────────

const EARTH_KM = 6371
const rad = (deg: number) => deg * Math.PI / 180

export function haversineKm(a: Point, b: Point): number {
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2
  return EARTH_KM * 2 * Math.asin(Math.sqrt(Math.min(1, h)))
}

export function polylineKm(points: readonly Point[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += haversineKm(points[i - 1], points[i])
  return total
}

/**
 * Points régulièrement espacés le long du tracé (départ et arrivée compris), au plus `maxSamples`, et rayon de couloir
 * qui couvre l'espace entre deux points : chaque station du couloir est à moins de `radiusKm` d'un point.
 */
export function samplePolyline(points: readonly Point[], maxSamples = 160): { samples: Point[]; radiusKm: number } {
  if (!points.length) return { samples: [], radiusKm: 1 }
  const total = polylineKm(points)
  const spacing = Math.max(2, total / Math.max(1, maxSamples - 1))
  const samples: Point[] = [points[0]]
  let carried = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i]
    const segment = haversineKm(a, b)
    let position = spacing - carried
    while (position <= segment && samples.length < maxSamples - 1) {
      const t = segment === 0 ? 0 : position / segment
      samples.push({ latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t })
      position += spacing
    }
    carried = (carried + segment) % spacing
  }
  const last = points[points.length - 1]
  if (samples.length === 1 || haversineKm(samples[samples.length - 1], last) > 0.05) samples.push(last)
  return { samples, radiusKm: Math.round((Math.max(1, spacing / 2 + 0.25)) * 100) / 100 }
}

/** Distance d'un point au tracé (projection locale équirectangulaire, suffisante à l'échelle d'un trajet). */
export function distanceToPolylineKm(point: Point, line: readonly Point[]): number {
  if (!line.length) return Infinity
  if (line.length === 1) return haversineKm(point, line[0])
  const k = Math.cos(rad(point.latitude))
  const xy = (p: Point) => ({ x: rad(p.longitude) * k * EARTH_KM, y: rad(p.latitude) * EARTH_KM })
  const p = xy(point)
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const a = xy(line[i - 1]), b = xy(line[i])
    const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2))
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)))
  }
  return best
}

/** Les stations les moins chères du couloir, puis les plus proches du trajet. */
export function rankStations(stations: readonly FuelStation[], limit = 8): FuelStation[] {
  return [...stations].sort((a, b) => a.price - b.price || a.offRouteKm - b.offRouteKm || a.id.localeCompare(b.id)).slice(0, limit)
}

// ─── Estimation ──────────────────────────────────────────────────────────────

export const CONSUMPTION_BOUNDS = { min: 1, max: 80 } as const

/** Saisie française « 9,5 » → 9.5 ; null si vide ou hors bornes. */
export function parseConsumption(raw: string): number | null {
  const value = Number(raw.trim().replace(",", "."))
  return raw.trim() && Number.isFinite(value) && value >= CONSUMPTION_BOUNDS.min && value <= CONSUMPTION_BOUNDS.max ? value : null
}

/** Litres = km × L/100 km ÷ 100 (3 décimales) ; montant = litres × prix (2 décimales). Null si une donnée manque. */
export function estimateFuel(input: { km: number | null; consumptionLPer100Km: number | null; pricePerLitre: number | null }): { litres: number; amount: number } | null {
  const { km, consumptionLPer100Km: c, pricePerLitre: price } = input
  if (km === null || c === null || price === null || !(km > 0) || km > 10_000 || !(c >= CONSUMPTION_BOUNDS.min) || c > CONSUMPTION_BOUNDS.max || !(price > 0) || price > 10) return null
  const litres = Math.round(km * c / 100 * 1000) / 1000
  return { litres, amount: Math.round(litres * price * 100) / 100 }
}

export function decimalFr(value: number, digits: number): string {
  return value.toFixed(digits).replace(".", ",")
}

export const ESTIMATE_NOTE_PREFIX = "Estimation trajet :"

/** Note ajoutée à la dépense : la provenance du calcul reste lisible dans le registre. */
const dayFr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** Prix retenu : une station précise, ou la médiane des stations du couloir. */
export type PriceChoice = { kind: "STATION"; station: FuelStation } | { kind: "MEDIAN"; stats: PriceStats; date: string }
export const choicePrice = (choice: PriceChoice) => choice.kind === "STATION" ? choice.station.price : choice.stats.median

/** Note ajoutée à la dépense : la provenance du calcul reste lisible dans le registre. */
export function estimateNote(input: { km: number; kmSource: KmSource; extraKm?: number; consumption: number; price: PriceChoice; fuel: FuelType; stay?: PlannedStay | null }): string {
  const source = input.kmSource === "ODOMETER" ? "compteur" : "itinéraire aller-retour"
  const where = input.stay ? ` chantier ${input.stay.worksiteName} (départ ${dayFr(input.stay.departure)}, retour ${dayFr(input.stay.return)})` : ""
  const extra = input.extraKm ? ` + ${input.extraKm} km sur place` : ""
  const price = input.price.kind === "STATION"
    ? `${decimalFr(input.price.station.price, 3)} €/L ${FUEL_LABELS[input.fuel]} (${input.price.station.label}, ${input.price.station.city}, prix du ${dayFr(input.price.station.updatedAt)})`
    : `${decimalFr(input.price.stats.median, 3)} €/L ${FUEL_LABELS[input.fuel]} (prix médian de ${input.price.stats.count} stations du trajet au ${dayFr(input.price.date)})`
  return `${ESTIMATE_NOTE_PREFIX}${where} ${input.km - (input.extraKm ?? 0)} km (${source})${extra} × ${decimalFr(input.consumption, 1)} L/100 km × ${price}. À remplacer par le montant du ticket.`
}
