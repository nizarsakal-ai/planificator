/**
 * Géoplateforme IGN : itinéraire et géocodage publics, gratuits et sans clé.
 * Corps de réponse borné, délai court, aucune donnée personnelle envoyée (coordonnées et adresse de chantier).
 */
import { readImportBoundedBody } from "./import-bounded-body"
import { MileageDomainError } from "./mileage-domain"
import type { Point } from "./planned-mileage-domain"

const ROUTE_URL = "https://data.geopf.fr/navigation/itineraire"
const GEOCODE_URL = "https://data.geopf.fr/geocodage/search"
const TIMEOUT_MS = 5_000

async function getJson(url: URL, fetchFn: typeof fetch, unavailable: string): Promise<any> {
  let response: Response
  try { response = await fetchFn(url.href, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }) }
  catch { throw new MileageDomainError(unavailable, 503) }
  if (response.status === 429) throw new MileageDomainError(unavailable, 429)
  if (!response.ok) throw new MileageDomainError(unavailable, 503)
  const bytes = await readImportBoundedBody(response, { decodedContent: true, maxBytes: 200_000, timeoutMs: TIMEOUT_MS, invalidStatus: 502, limitCode: unavailable })
  try { return JSON.parse(bytes.toString("utf8")) } catch { throw new MileageDomainError(unavailable, 502) }
}

/** Distance routière aller simple en kilomètres, profil voiture. */
export async function ignRouteKm(from: Point, to: Point, fetchFn: typeof fetch = fetch): Promise<number> {
  const url = new URL(ROUTE_URL)
  for (const [key, value] of Object.entries({
    resource: "bdtopo-valhalla", profile: "car", optimization: "fastest",
    start: `${from.longitude},${from.latitude}`, end: `${to.longitude},${to.latitude}`,
    getSteps: "false", getBbox: "false", distanceUnit: "kilometer", geometryFormat: "geojson",
  })) url.searchParams.set(key, value)
  const data = await getJson(url, fetchFn, "ROUTING_UNAVAILABLE")
  const km = data?.distance
  if (typeof km !== "number" || !Number.isFinite(km) || km < 0 || km > 5_000 || data?.distanceUnit !== "kilometer")
    throw new MileageDomainError("INVALID_ROUTE_DISTANCE", 502)
  return km
}

/** Coordonnées d'une adresse, ou null si l'IGN ne la reconnaît pas avec assez de confiance. */
export async function ignGeocode(address: string, fetchFn: typeof fetch = fetch): Promise<Point | null> {
  const q = address.trim()
  if (q.length < 3 || q.length > 500) return null
  const url = new URL(GEOCODE_URL)
  url.searchParams.set("q", q); url.searchParams.set("index", "address"); url.searchParams.set("limit", "1")
  const data = await getJson(url, fetchFn, "GEOCODING_UNAVAILABLE")
  if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) throw new MileageDomainError("INVALID_GEOCODING_RESULT", 502)
  const feature = data.features[0]
  if (!feature) return null
  const c = feature.geometry?.coordinates, score = feature.properties?.score
  if (feature.geometry?.type !== "Point" || !Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite)
    || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90 || !Number.isFinite(score)) throw new MileageDomainError("INVALID_GEOCODING_RESULT", 502)
  // Même seuil que le géocodage des imports véhicules.
  if (score < 0.6) return null
  return { longitude: c[0], latitude: c[1] }
}
