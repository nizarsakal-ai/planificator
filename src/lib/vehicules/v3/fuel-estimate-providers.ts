/**
 * Véhicules V3 — sources publiques gratuites et sans clé de l'estimation carburant :
 * tracé IGN Géoplateforme (itinéraire) et prix du flux instantané des carburants (data.economie.gouv.fr).
 * Seules des coordonnées sont envoyées (siège, chantier, points du tracé) ; corps borné, délai court, valeurs contrôlées.
 */
import { readImportBoundedBody } from "../import-bounded-body"
import { MileageDomainError } from "../mileage-domain"
import { distanceToPolylineKm, type FuelStation, type FuelType, type Point } from "./fuel-estimate-domain"

const ROUTE_URL = "https://data.geopf.fr/navigation/itineraire"
const PRICES_URL = "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records"
const TIMEOUT_MS = 6_000
const MAX_ROUTE_POINTS = 20_000

async function getJson(url: URL, fetchFn: typeof fetch, unavailable: string, maxBytes: number): Promise<any> {
  let response: Response
  try { response = await fetchFn(url.href, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }) }
  catch { throw new MileageDomainError(unavailable, 503) }
  if (response.status === 429) throw new MileageDomainError(unavailable, 429)
  if (!response.ok) throw new MileageDomainError(unavailable, 503)
  const bytes = await readImportBoundedBody(response, { decodedContent: true, maxBytes, timeoutMs: TIMEOUT_MS, invalidStatus: 502, limitCode: unavailable })
  try { return JSON.parse(bytes.toString("utf8")) } catch { throw new MileageDomainError(unavailable, 502) }
}

const validPoint = (p: Point) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180

/** Itinéraire voiture aller simple : distance (km) et tracé. */
export async function ignRouteGeometry(from: Point, to: Point, fetchFn: typeof fetch = fetch): Promise<{ km: number; points: Point[] }> {
  const url = new URL(ROUTE_URL)
  for (const [key, value] of Object.entries({
    resource: "bdtopo-valhalla", profile: "car", optimization: "fastest",
    start: `${from.longitude},${from.latitude}`, end: `${to.longitude},${to.latitude}`,
    getSteps: "false", getBbox: "false", distanceUnit: "kilometer", geometryFormat: "geojson",
  })) url.searchParams.set(key, value)
  const data = await getJson(url, fetchFn, "ROUTING_UNAVAILABLE", 3_000_000)
  const km = data?.distance, coordinates = data?.geometry?.coordinates
  if (typeof km !== "number" || !Number.isFinite(km) || km < 0 || km > 5_000 || data?.distanceUnit !== "kilometer"
    || data?.geometry?.type !== "LineString" || !Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > MAX_ROUTE_POINTS)
    throw new MileageDomainError("INVALID_ROUTE", 502)
  const points = coordinates.map((c: unknown) => Array.isArray(c) ? { longitude: Number(c[0]), latitude: Number(c[1]) } : { longitude: NaN, latitude: NaN })
  if (!points.every(validPoint)) throw new MileageDomainError("INVALID_ROUTE", 502)
  return { km, points }
}

const FIELD: Record<FuelType, string> = { GAZOLE: "gazole", E10: "e10", SP95: "sp95", SP98: "sp98", E85: "e85", GPLC: "gplc" }
const clean = (value: unknown, max: number) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max) : ""

/**
 * Stations à moins de `radiusKm` d'au moins un point du couloir, avec un prix publié pour ce carburant.
 * L'écart au trajet est recalculé localement sur le tracé `line` ; au plus 100 stations, les moins chères d'abord.
 */
export async function stationsInCorridor(samples: readonly Point[], radiusKm: number, line: readonly Point[], fuel: FuelType, fetchFn: typeof fetch = fetch): Promise<FuelStation[]> {
  if (!samples.length || samples.length > 40 || !samples.every(validPoint) || !(radiusKm > 0) || radiusKm > 20) throw new MileageDomainError("INVALID_CORRIDOR", 400)
  const f = FIELD[fuel]
  const circles = samples.map((p) => `within_distance(geom, geom'POINT(${p.longitude.toFixed(5)} ${p.latitude.toFixed(5)})', ${radiusKm.toFixed(2)}km)`)
  const url = new URL(PRICES_URL)
  url.searchParams.set("where", `(${circles.join(" OR ")}) AND ${f}_prix IS NOT NULL`)
  url.searchParams.set("select", `id,adresse,ville,geom,${f}_prix,${f}_maj,horaires_automate_24_24`)
  url.searchParams.set("order_by", `${f}_prix`)
  url.searchParams.set("limit", "100")
  const data = await getJson(url, fetchFn, "FUEL_PRICES_UNAVAILABLE", 500_000)
  if (!Array.isArray(data?.results)) throw new MileageDomainError("INVALID_FUEL_PRICES", 502)
  const out: FuelStation[] = []
  for (const row of data.results.slice(0, 100)) {
    const price = Number(row?.[`${f}_prix`]), updatedAt = clean(row?.[`${f}_maj`], 40)
    const point = { latitude: Number(row?.geom?.lat), longitude: Number(row?.geom?.lon) }
    const id = String(row?.id ?? "").slice(0, 20)
    if (!/^\d{3,12}$/.test(id) || !(price > 0.3 && price < 10) || !validPoint(point) || Number.isNaN(Date.parse(updatedAt))) continue
    const offRouteKm = Math.round(distanceToPolylineKm(point, line.length ? line : samples) * 10) / 10
    if (offRouteKm > radiusKm + 0.5) continue
    out.push({ id, label: clean(row.adresse, 120) || "Station", city: clean(row.ville, 80), price, updatedAt: new Date(updatedAt).toISOString(), offRouteKm, open24h: row.horaires_automate_24_24 === "Oui" })
  }
  return out
}
