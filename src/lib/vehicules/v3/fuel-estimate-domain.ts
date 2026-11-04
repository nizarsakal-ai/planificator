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
export type KmSource = "ODOMETER" | "ROUTE_ROUND_TRIP"
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

export interface FuelEstimate {
  tripId: string
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
export function samplePolyline(points: readonly Point[], maxSamples = 30): { samples: Point[]; radiusKm: number } {
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
export function estimateNote(input: { km: number; kmSource: KmSource; consumption: number; station: FuelStation; fuel: FuelType }): string {
  const source = input.kmSource === "ODOMETER" ? "compteur" : "itinéraire aller-retour"
  const priceDate = `${input.station.updatedAt.slice(8, 10)}/${input.station.updatedAt.slice(5, 7)}/${input.station.updatedAt.slice(0, 4)}`
  return `${ESTIMATE_NOTE_PREFIX} ${input.km} km (${source}) × ${decimalFr(input.consumption, 1)} L/100 km × ${decimalFr(input.station.price, 3)} €/L ${FUEL_LABELS[input.fuel]} (${input.station.label}, ${input.station.city}, prix du ${priceDate}). À remplacer par le montant du ticket.`
}
