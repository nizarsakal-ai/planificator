/**
 * Véhicules V3 — estimation carburant d'un trajet (lecture seule, derrière PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED).
 * Droits relus en transaction courte (administrateur de l'entreprise de la session, comme les coûts) ; appels publics
 * hors transaction, bornés par le quota horaire par société et mis en cache par société. Rien n'est écrit hormis le cache :
 * ni dépense, ni imputation, ni compteur. Aucune valeur n'est journalisée.
 */
import { createHash } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import { MileageDomainError, getMileageTripDistance, resolveMileageHistory } from "../mileage-domain"
import { requireMileageSession, type MileageSession } from "../mileage-access"
import { authorizeVehicleLocked } from "../vehicle-authority"
import { reserveImportProvider } from "../import-provider-quota"
import { PLANNED_MILEAGE_DEPOT, hasPlannedMileageDepot } from "../planned-mileage-domain"
import { ignGeocode } from "../planned-mileage-ign"
import { civilDate } from "./document-domain"
import { expenseGate } from "./expense-service"
import {
  FUEL_TYPES, isFuelEstimateEnabled, rankStations, samplePolyline,
  type FuelEstimate, type FuelStation, type FuelType, type Point, type RouteStatus, type StationsStatus,
} from "./fuel-estimate-domain"
import { ignRouteGeometry, stationsInCorridor } from "./fuel-estimate-providers"

export interface FuelEstimateDeps {
  auth: () => Promise<MileageSession | null>
  db: Pick<PrismaClient, "$transaction">
  fetchFn?: typeof fetch
  env?: Record<string, string | undefined>
}

type Tx = Prisma.TransactionClient
const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 }
const ROUTE_TTL = "30 days"
const PRICES_TTL = "1 hour"
/** Sans tracé : stations autour du chantier ou du siège. */
const NEAR_RADIUS_KM = 3

type RouteValue = { oneWayKm: number; samples: Point[]; radiusKm: number; line: Point[] }
/** Tracé simplifié conservé en cache : au plus 200 points, départ et arrivée compris (écart au trajet des stations). */
function simplify(points: readonly Point[], max = 200): Point[] {
  if (points.length <= max) return [...points]
  const step = (points.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)])
}

const key = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex")

async function cached<T>(db: FuelEstimateDeps["db"], companyId: string, cacheKey: string): Promise<T | null> {
  const rows = await db.$transaction((tx: Tx) => tx.$queryRaw<{ value: T }[]>`
    SELECT "value" FROM "vehicle_cartography_cache" WHERE "key" = ${cacheKey} AND "companyId" = ${companyId} AND "expiresAt" > clock_timestamp()`, transactionOptions)
  return rows[0]?.value ?? null
}

async function store(db: FuelEstimateDeps["db"], companyId: string, cacheKey: string, value: unknown, ttl: string) {
  await db.$transaction((tx: Tx) => tx.$executeRaw`INSERT INTO "vehicle_cartography_cache" ("key","companyId","value","expiresAt")
    VALUES (${cacheKey}, ${companyId}, ${JSON.stringify(value)}::jsonb, clock_timestamp() + ${ttl}::interval)
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "expiresAt" = EXCLUDED."expiresAt"`, transactionOptions)
}

/** Quota horaire par société partagé avec les imports (contrainte SQL : ROUTING ou GEOCODING) ; les prix comptent en ROUTING. */
async function reserve(db: FuelEstimateDeps["db"], companyId: string, provider: "ROUTING" | "GEOCODING") {
  await db.$transaction((tx: Tx) => reserveImportProvider(tx, companyId, provider), transactionOptions)
}

function parseQuery(tripId: string | null, fuel: string | null): { tripId: string; fuel: FuelType } {
  const id = tripId?.trim() ?? ""
  if (!id || id.length > 200 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new MileageDomainError("INVALID_FUEL_ESTIMATE_QUERY", 400)
  const f = (fuel?.trim() || "GAZOLE").toUpperCase()
  if (!(FUEL_TYPES as readonly string[]).includes(f)) throw new MileageDomainError("INVALID_FUEL_ESTIMATE_QUERY", 400)
  return { tripId: id, fuel: f as FuelType }
}

/** Siège → chantier : tracé échantillonné en cache, sinon itinéraire IGN (quota). Null si impossible. */
async function routeFor(deps: FuelEstimateDeps, companyId: string, target: Point): Promise<RouteValue | null> {
  const cacheKey = key(["fuel-route-v2", companyId, PLANNED_MILEAGE_DEPOT.latitude, PLANNED_MILEAGE_DEPOT.longitude, target.latitude.toFixed(5), target.longitude.toFixed(5)])
  const hit = await cached<RouteValue>(deps.db, companyId, cacheKey)
  if (hit) return hit
  try {
    await reserve(deps.db, companyId, "ROUTING")
    const route = await ignRouteGeometry(PLANNED_MILEAGE_DEPOT, target, deps.fetchFn)
    const { samples, radiusKm } = samplePolyline(route.points)
    const value = { oneWayKm: Math.round(route.km * 10) / 10, samples, radiusKm, line: simplify(route.points) }
    await store(deps.db, companyId, cacheKey, value, ROUTE_TTL)
    return value
  } catch (error) {
    if (error instanceof MileageDomainError) return null
    throw error
  }
}

async function stationsFor(deps: FuelEstimateDeps, companyId: string, samples: Point[], radiusKm: number, line: Point[], fuel: FuelType): Promise<FuelStation[] | null> {
  const cacheKey = key(["fuel-stations-v1", companyId, fuel, radiusKm, samples.map((p) => [p.latitude.toFixed(4), p.longitude.toFixed(4)])])
  const hit = await cached<FuelStation[]>(deps.db, companyId, cacheKey)
  if (hit) return hit
  try {
    await reserve(deps.db, companyId, "ROUTING")
    const stations = rankStations(await stationsInCorridor(samples, radiusKm, line, fuel, deps.fetchFn))
    await store(deps.db, companyId, cacheKey, stations, PRICES_TTL)
    return stations
  } catch (error) {
    if (error instanceof MileageDomainError) return null
    throw error
  }
}

export async function readFuelEstimate(truckId: string, query: { tripId: string | null; fuel: string | null }, deps: FuelEstimateDeps): Promise<FuelEstimate> {
  expenseGate()
  if (!isFuelEstimateEnabled(deps.env ?? process.env)) throw new MileageDomainError("FUEL_ESTIMATE_DISABLED", 404)
  const { tripId, fuel } = parseQuery(query.tripId, query.fuel)
  const session = requireMileageSession(await deps.auth())
  const scope = { companyId: session.companyId, truckId }

  const trip = await deps.db.$transaction(async (tx: Tx) => {
    await authorizeVehicleLocked(tx, truckId, session, "READING")
    const row = await tx.mileageTrip.findFirst({ where: { ...scope, id: tripId }, include: { startEntry: true } })
    if (!row) throw new MileageDomainError("TRIP_NOT_FOUND", 404)
    const entries = await tx.mileageEntry.findMany({ where: scope, orderBy: { revision: "asc" } })
    const history = resolveMileageHistory(entries)
    const km = getMileageTripDistance(history, row)
    const reading = history.byOriginalId.get(row.endEntryId ?? row.startEntryId)
    const worksite = row.worksiteId ? await tx.worksite.findFirst({ where: { id: row.worksiteId, companyId: session.companyId }, select: { name: true, address: true, latitude: true, longitude: true } }) : null
    const settings = await tx.companySettings.findFirst({ where: { companyId: session.companyId }, select: { timezone: true } })
    return {
      km, closed: !!row.endEntryId, odometer: reading?.effective.mileage ?? null,
      date: civilDate(row.startEntry.occurredAt ?? row.startEntry.recordedAt, settings?.timezone ?? "Europe/Paris"),
      worksite, worksiteName: row.worksiteNameSnapshot ?? worksite?.name ?? null,
    }
  }, transactionOptions)

  // Point du chantier : coordonnées enregistrées, sinon géocodage IGN de son adresse (quota).
  let target: Point | null = null
  let routeStatus: RouteStatus = "ROUTE"
  const w = trip.worksite
  if (!w) routeStatus = "NO_WORKSITE"
  else if (Number.isFinite(w.latitude) && Number.isFinite(w.longitude)) target = { latitude: w.latitude!, longitude: w.longitude! }
  else if (w.address?.trim()) {
    try { await reserve(deps.db, session.companyId, "GEOCODING"); target = await ignGeocode(w.address, deps.fetchFn) }
    catch (error) { if (!(error instanceof MileageDomainError)) throw error }
    if (!target) routeStatus = "ADDRESS_NOT_FOUND"
  } else routeStatus = "ADDRESS_NOT_FOUND"

  const depotKnown = hasPlannedMileageDepot(session.companyId)
  let route: RouteValue | null = null
  if (target && depotKnown) { route = await routeFor(deps, session.companyId, target); if (!route) routeStatus = "UNAVAILABLE" }
  else if (target) routeStatus = "NO_DEPOT"

  let stationsStatus: StationsStatus
  let corridor: { samples: Point[]; radiusKm: number; line: Point[] } | null
  if (route) { stationsStatus = "ROUTE_CORRIDOR"; corridor = route }
  else if (target) { stationsStatus = "NEAR_WORKSITE"; corridor = { samples: [target], radiusKm: NEAR_RADIUS_KM, line: [target] } }
  else if (depotKnown) { const depot = { latitude: PLANNED_MILEAGE_DEPOT.latitude, longitude: PLANNED_MILEAGE_DEPOT.longitude }; stationsStatus = "NEAR_DEPOT"; corridor = { samples: [depot], radiusKm: NEAR_RADIUS_KM, line: [depot] } }
  else { stationsStatus = "NONE"; corridor = null }
  let stations: FuelStation[] = []
  if (corridor) {
    const found = await stationsFor(deps, session.companyId, corridor.samples, corridor.radiusKm, corridor.line, fuel)
    if (found) stations = found
    else stationsStatus = "UNAVAILABLE"
  }

  const kmSource = trip.km !== null ? "ODOMETER" as const : route ? "ROUTE_ROUND_TRIP" as const : null
  const km = trip.km !== null ? trip.km : route ? Math.round(route.oneWayKm * 2) : null
  return {
    tripId, tripDate: trip.date, tripClosed: trip.closed, worksiteName: trip.worksiteName, odometer: trip.odometer,
    km, kmSource, route: { status: routeStatus, oneWayKm: route?.oneWayKm ?? null }, fuel, stations, stationsStatus,
  }
}
