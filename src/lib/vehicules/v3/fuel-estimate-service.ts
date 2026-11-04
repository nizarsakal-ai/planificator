/**
 * Véhicules V3 — estimation carburant (lecture seule, derrière PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED).
 * Deux sources de trajet : un trajet relevé au compteur, ou un séjour planifié sur un chantier (départ le premier jour,
 * retour le dernier, équipe et chauffeur tirés du planning et des périodes du camion).
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
import { PLANNED_MILEAGE_DEPOT, hasPlannedMileageDepot, parisDay } from "../planned-mileage-domain"
import { ignGeocode } from "../planned-mileage-ign"
import { civilDate } from "./document-domain"
import { expenseGate } from "./expense-service"
import {
  FUEL_TYPES, STAY_ID, isFuelEstimateEnabled, priceStats, rankStations, resolveStays, samplePolyline,
  type FuelEstimate, type FuelStation, type FuelType, type PlannedStay, type Point, type PriceStats, type RouteStatus,
  type StationsStatus, type StayAssignment, type StayTruckPeriod,
} from "./fuel-estimate-domain"
import { ignRouteGeometry, stationsInCorridor } from "./fuel-estimate-providers"

export interface FuelEstimateDeps {
  auth: () => Promise<MileageSession | null>
  db: Pick<PrismaClient, "$transaction">
  fetchFn?: typeof fetch
  env?: Record<string, string | undefined>
  now?: () => Date
}

type Tx = Prisma.TransactionClient
const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 }
const ROUTE_TTL = "30 days"
const PRICES_TTL = "1 hour"
/** Sans tracé : stations autour du chantier ou du siège. */
const NEAR_RADIUS_KM = 3
/** Cercles par requête de prix (longueur d'URL bornée) et requêtes au plus par estimation. */
const CIRCLES_PER_REQUEST = 40
const MAX_PRICE_REQUESTS = 4
/** Fenêtre des séjours proposés : 60 jours passés, 60 jours à venir. */
const STAY_WINDOW_DAYS = 60
const MAX_STAYS = 60

type RouteValue = { oneWayKm: number; samples: Point[]; radiusKm: number; line: Point[] }
type StationsValue = { stations: FuelStation[]; stats: PriceStats | null }

/** Tracé simplifié conservé en cache : au plus 200 points, départ et arrivée compris (écart au trajet des stations). */
function simplify(points: readonly Point[], max = 200): Point[] {
  if (points.length <= max) return [...points]
  const step = (points.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)])
}

const key = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex")
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const dateColumn = (day: string) => new Date(`${day}T00:00:00.000Z`)

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

function gate(deps: FuelEstimateDeps) {
  expenseGate()
  if (!isFuelEstimateEnabled(deps.env ?? process.env)) throw new MileageDomainError("FUEL_ESTIMATE_DISABLED", 404)
}

function parseQuery(query: { tripId: string | null; stayId: string | null; fuel: string | null }) {
  const tripId = query.tripId?.trim() || null, stayId = query.stayId?.trim() || null
  if ((tripId ? 1 : 0) + (stayId ? 1 : 0) !== 1) throw new MileageDomainError("INVALID_FUEL_ESTIMATE_QUERY", 400)
  if (tripId && (tripId.length > 200 || !/^[A-Za-z0-9_-]+$/.test(tripId))) throw new MileageDomainError("INVALID_FUEL_ESTIMATE_QUERY", 400)
  if (stayId && !STAY_ID.test(stayId)) throw new MileageDomainError("INVALID_FUEL_ESTIMATE_QUERY", 400)
  const fuel = (query.fuel?.trim() || "GAZOLE").toUpperCase()
  if (!(FUEL_TYPES as readonly string[]).includes(fuel)) throw new MileageDomainError("INVALID_FUEL_ESTIMATE_QUERY", 400)
  return { tripId, stayId, fuel: fuel as FuelType }
}

// ─── Séjours planifiés ───────────────────────────────────────────────────────

const fullName = (e: { firstName: string; lastName: string } | null | undefined) => e ? `${e.firstName} ${e.lastName}`.trim() : null

/**
 * Séjours du camion entre `from` et `to` (jours inclus) : périodes du camion (équipe, chauffeur), jours de planning de
 * ces équipes (refus exclus), noms d'équipe, de chef et de chauffeur. Sans aucune période enregistrée, l'équipe et le
 * chauffeur actuels du camion tiennent lieu de période ouverte (même règle que le kilométrage prévu).
 */
async function loadStays(tx: Tx, scope: { companyId: string; truckId: string }, truck: { teamId: string | null; chauffeurId: string | null }, from: string, to: string, filter?: { worksiteId: string; teamId: string }) {
  let periods: StayTruckPeriod[] = (await tx.truckAssignment.findMany({
    where: { ...scope, startedAt: { lt: dateColumn(addDays(to, 1)) }, OR: [{ endedAt: null }, { endedAt: { gte: dateColumn(from) } }] },
    select: { teamId: true, chauffeurId: true, startedAt: true, endedAt: true },
  })).map((p) => ({ teamId: p.teamId, chauffeurId: p.chauffeurId, from: parisDay(p.startedAt), to: p.endedAt ? parisDay(p.endedAt) : null }))
  if (!periods.length && truck.teamId && await tx.truckAssignment.count({ where: scope }) === 0)
    periods = [{ teamId: truck.teamId, chauffeurId: truck.chauffeurId, from: "0000-01-01", to: null }]
  const teamIds = [...new Set(periods.map((p) => p.teamId).filter((id): id is string => !!id))].filter((id) => !filter || id === filter.teamId)
  if (!teamIds.length) return []
  const rows = await tx.assignment.findMany({
    where: { teamId: { in: teamIds }, date: { gte: dateColumn(from), lte: dateColumn(to) }, status: { not: "REFUSED" },
      team: { companyId: scope.companyId }, worksite: { companyId: scope.companyId, ...(filter ? { id: filter.worksiteId } : {}) } },
    select: { date: true, teamId: true, worksite: { select: { id: true, name: true, address: true } } },
    take: 2_000,
  })
  const assignments: StayAssignment[] = rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), teamId: r.teamId, worksite: r.worksite }))
  const stays = resolveStays(assignments, periods)
  const teams = await tx.team.findMany({ where: { id: { in: [...new Set(stays.map((s) => s.teamId))] }, companyId: scope.companyId }, select: { id: true, name: true, leaderId: true } })
  const employeeIds = [...new Set([...teams.map((t) => t.leaderId), ...stays.map((s) => s.chauffeurId).filter((id): id is string => !!id)])]
  const employees = employeeIds.length ? await tx.employee.findMany({ where: { id: { in: employeeIds }, companyId: scope.companyId }, select: { id: true, firstName: true, lastName: true } }) : []
  const team = new Map(teams.map((t) => [t.id, t])), person = new Map(employees.map((e) => [e.id, e]))
  return stays.map(({ chauffeurId, ...stay }): PlannedStay => ({
    ...stay, teamName: team.get(stay.teamId)?.name ?? null,
    leaderName: fullName(person.get(team.get(stay.teamId)?.leaderId ?? "")), chauffeurName: chauffeurId ? fullName(person.get(chauffeurId)) : null,
  }))
}

/** Séjours planifiés du camion autour d'aujourd'hui (Paris), du plus récent au plus ancien. */
export async function listPlannedStays(truckId: string, deps: FuelEstimateDeps): Promise<{ stays: PlannedStay[] }> {
  gate(deps)
  const session = requireMileageSession(await deps.auth())
  const today = parisDay(deps.now?.() ?? new Date())
  return deps.db.$transaction(async (tx: Tx) => {
    const { truck } = await authorizeVehicleLocked(tx, truckId, session, "READING")
    const stays = await loadStays(tx, { companyId: session.companyId, truckId }, truck, addDays(today, -STAY_WINDOW_DAYS), addDays(today, STAY_WINDOW_DAYS))
    return { stays: stays.slice(0, MAX_STAYS) }
  }, transactionOptions)
}

// ─── Itinéraire et prix ──────────────────────────────────────────────────────

/** Siège → chantier : tracé échantillonné en cache, sinon itinéraire IGN (quota). Null si impossible. */
async function routeFor(deps: FuelEstimateDeps, companyId: string, target: Point): Promise<RouteValue | null> {
  const cacheKey = key(["fuel-route-v3", companyId, PLANNED_MILEAGE_DEPOT.latitude, PLANNED_MILEAGE_DEPOT.longitude, target.latitude.toFixed(5), target.longitude.toFixed(5)])
  const hit = await cached<RouteValue>(deps.db, companyId, cacheKey)
  if (hit) return hit
  try {
    await reserve(deps.db, companyId, "ROUTING")
    const route = await ignRouteGeometry(PLANNED_MILEAGE_DEPOT, target, deps.fetchFn)
    const { samples, radiusKm } = samplePolyline(route.points, CIRCLES_PER_REQUEST * MAX_PRICE_REQUESTS)
    const value = { oneWayKm: Math.round(route.km * 10) / 10, samples, radiusKm, line: simplify(route.points) }
    await store(deps.db, companyId, cacheKey, value, ROUTE_TTL)
    return value
  } catch (error) {
    if (error instanceof MileageDomainError) return null
    throw error
  }
}

/** Stations du couloir, en au plus 4 requêtes de 40 cercles ; les 8 moins chères et les statistiques de prix sur toutes. */
async function stationsFor(deps: FuelEstimateDeps, companyId: string, corridor: { samples: Point[]; radiusKm: number; line: Point[] }, fuel: FuelType): Promise<StationsValue | null> {
  const cacheKey = key(["fuel-stations-v2", companyId, fuel, corridor.radiusKm, corridor.samples.map((p) => [p.latitude.toFixed(4), p.longitude.toFixed(4)])])
  const hit = await cached<StationsValue>(deps.db, companyId, cacheKey)
  if (hit) return hit
  try {
    const found = new Map<string, FuelStation>()
    for (let i = 0; i < corridor.samples.length && i < CIRCLES_PER_REQUEST * MAX_PRICE_REQUESTS; i += CIRCLES_PER_REQUEST) {
      await reserve(deps.db, companyId, "ROUTING")
      for (const station of await stationsInCorridor(corridor.samples.slice(i, i + CIRCLES_PER_REQUEST), corridor.radiusKm, corridor.line, fuel, deps.fetchFn)) found.set(station.id, station)
    }
    const all = [...found.values()]
    const value = { stations: rankStations(all), stats: priceStats(all) }
    await store(deps.db, companyId, cacheKey, value, PRICES_TTL)
    return value
  } catch (error) {
    if (error instanceof MileageDomainError) return null
    throw error
  }
}

// ─── Estimation ──────────────────────────────────────────────────────────────

type Worksite = { name: string; address: string | null; latitude: number | null; longitude: number | null } | null

export async function readFuelEstimate(truckId: string, query: { tripId: string | null; stayId?: string | null; fuel: string | null }, deps: FuelEstimateDeps): Promise<FuelEstimate> {
  gate(deps)
  const { tripId, stayId, fuel } = parseQuery({ tripId: query.tripId, stayId: query.stayId ?? null, fuel: query.fuel })
  const session = requireMileageSession(await deps.auth())
  const scope = { companyId: session.companyId, truckId }
  const worksiteSelect = { name: true, address: true, latitude: true, longitude: true } as const

  const base = await deps.db.$transaction(async (tx: Tx) => {
    const { truck } = await authorizeVehicleLocked(tx, truckId, session, "READING")
    if (stayId) {
      const [worksiteId, teamId, departure] = stayId.split("~")
      // Le séjour est recalculé depuis le planning : un identifiant forgé ou périmé ne correspond à rien.
      const stays = await loadStays(tx, scope, truck, addDays(departure, -1), addDays(departure, 120), { worksiteId, teamId })
      const stay = stays.find((s) => s.id === stayId)
      if (!stay) throw new MileageDomainError("STAY_NOT_FOUND", 404)
      const worksite: Worksite = await tx.worksite.findFirst({ where: { id: worksiteId, companyId: session.companyId }, select: worksiteSelect })
      return { source: "STAY" as const, id: stayId, stay, km: null, closed: false, odometer: null, date: stay.departure, worksite, worksiteName: stay.worksiteName }
    }
    const row = await tx.mileageTrip.findFirst({ where: { ...scope, id: tripId! }, include: { startEntry: true } })
    if (!row) throw new MileageDomainError("TRIP_NOT_FOUND", 404)
    const entries = await tx.mileageEntry.findMany({ where: scope, orderBy: { revision: "asc" } })
    const history = resolveMileageHistory(entries)
    const reading = history.byOriginalId.get(row.endEntryId ?? row.startEntryId)
    const worksite: Worksite = row.worksiteId ? await tx.worksite.findFirst({ where: { id: row.worksiteId, companyId: session.companyId }, select: worksiteSelect }) : null
    const settings = await tx.companySettings.findFirst({ where: { companyId: session.companyId }, select: { timezone: true } })
    return {
      source: "TRIP" as const, id: row.id, stay: null, km: getMileageTripDistance(history, row), closed: !!row.endEntryId, odometer: reading?.effective.mileage ?? null,
      date: civilDate(row.startEntry.occurredAt ?? row.startEntry.recordedAt, settings?.timezone ?? "Europe/Paris"),
      worksite, worksiteName: row.worksiteNameSnapshot ?? worksite?.name ?? null,
    }
  }, transactionOptions)

  // Point du chantier : coordonnées enregistrées, sinon géocodage IGN de son adresse (quota).
  let target: Point | null = null
  let routeStatus: RouteStatus = "ROUTE"
  const w = base.worksite
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
  let found: StationsValue = { stations: [], stats: null }
  if (corridor) {
    const value = await stationsFor(deps, session.companyId, corridor, fuel)
    if (value) found = value
    else stationsStatus = "UNAVAILABLE"
  }

  const kmSource = base.km !== null ? "ODOMETER" as const : route ? (base.source === "STAY" ? "STAY_ROUND_TRIP" as const : "ROUTE_ROUND_TRIP" as const) : null
  const km = base.km !== null ? base.km : route ? Math.round(route.oneWayKm * 2) : null
  return {
    source: base.source, tripId: base.id, stay: base.stay, tripDate: base.date, tripClosed: base.closed, worksiteName: base.worksiteName, odometer: base.odometer,
    km, kmSource, route: { status: routeStatus, oneWayKm: route?.oneWayKm ?? null }, fuel,
    stations: found.stations, stationsStatus, priceStats: found.stats,
  }
}
