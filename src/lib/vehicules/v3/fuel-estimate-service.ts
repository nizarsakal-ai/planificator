/**
 * Véhicules V3 — estimation carburant (lecture seule, derrière PLANIFICATOR_VEHICLE_FUEL_ESTIMATE_ENABLED).
 * Deux sources de trajet : un trajet relevé au compteur, ou un séjour planifié sur un chantier (départ le premier jour,
 * retour le dernier, équipe et chauffeur tirés du planning et des périodes du camion).
 * Droits relus en transaction courte (administrateur de l'entreprise de la session, comme les coûts) ; appels publics
 * hors transaction, bornés par le quota horaire par société et mis en cache par société. Rien n'est écrit hormis le cache
 * et les fenêtres de quota : ni dépense, ni imputation, ni compteur. Aucune valeur n'est journalisée.
 * Données envoyées aux services publics : coordonnées seules (siège, chantier enregistré, points du tracé). Un chantier
 * sans coordonnées n'est pas géocodé par ce parcours : son adresse n'est jamais transmise.
 */
import { createHash } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import { MileageDomainError, getMileageTripDistance, resolveMileageHistory } from "../mileage-domain"
import { requireMileageSession, type MileageSession } from "../mileage-access"
import { authorizeVehicleLocked } from "../vehicle-authority"
import { reserveImportProvider } from "../import-provider-quota"
import { PLANNED_MILEAGE_DEPOT, hasPlannedMileageDepot, parisDay } from "../planned-mileage-domain"
import { civilDate } from "./document-domain"
import { expenseGate } from "./expense-service"
import {
  CORRIDOR_HALF_WIDTH_KM, FUEL_TYPES, GAP_DECISIONS, MAX_STAY_DAYS, STAY_EDGE_DAYS, STAY_ID, TRAVEL_MODES, addDays, isFuelEstimateEnabled, parisDayStart, priceStats,
  gapKey, rankStations, resolveStays, samplePolyline, simplifyPolyline, stayRoundTrips,
  type EstimateDecision, type FuelEstimate, type FuelStation, type FuelType, type GapDecision, type PlannedStay, type Point, type PriceStats, type RouteStatus,
  type StationsStatus, type StayAssignment, type StayScan, type StayTravel, type StayTruckPeriod, type TravelMode,
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
/** Fenêtre des séjours proposés : 60 jours passés, 60 jours à venir (séjours qui la touchent, bornes réelles). */
const STAY_WINDOW_DAYS = 60
const MAX_STAYS = 60
/** Lignes de planning lues par requête ; au-delà, la lecture est tronquée à un jour complet et signalée. */
export const MAX_PLANNING_ROWS = 2_000

type RouteValue = { oneWayKm: number; samples: Point[]; radiusKm: number; line: Point[]; toleranceKm: number }
type StationsValue = { stations: FuelStation[]; stats: PriceStats | null }
type Corridor = { samples: Point[]; radiusKm: number; line: Point[]; maxOffRouteKm: number }

const key = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex")
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
async function reserve(db: FuelEstimateDeps["db"], companyId: string, provider: "ROUTING") {
  await db.$transaction((tx: Tx) => reserveImportProvider(tx, companyId, provider), transactionOptions)
}

function gate(deps: FuelEstimateDeps) {
  expenseGate()
  if (!isFuelEstimateEnabled(deps.env ?? process.env)) throw new MileageDomainError("FUEL_ESTIMATE_DISABLED", 404)
}

export interface FuelEstimateQuery {
  tripId: string | null; stayId?: string | null; fuel: string | null
  /** Séjour : `ONE_ROUND_TRIP` ou `DAILY`, sans valeur par défaut. */
  mode?: string | null
  /** Séjour en ONE_ROUND_TRIP : `AAAA-MM-JJ..AAAA-MM-JJ:STAY|RETURN` séparés par des virgules (premier et dernier jour). */
  gaps?: string | null
  /** Empreinte du contexte du séjour sur lequel les décisions ont été prises (obligatoire avec mode/gaps/handover). */
  context?: string | null
  /** `1` : l'opérateur confirme que le siège est le vrai point de départ et de retour. */
  depot?: string | null
  /** Séjour réaffecté en journée : jours déclarés `AAAA-MM-JJ,…`, exactement ceux du séjour. */
  handover?: string | null
}

const invalid = () => new MileageDomainError("INVALID_FUEL_ESTIMATE_QUERY", 400)
const isDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && addDays(day, 0) === day

function parseQuery(query: FuelEstimateQuery) {
  const tripId = query.tripId?.trim() || null, stayId = query.stayId?.trim() || null
  if ((tripId ? 1 : 0) + (stayId ? 1 : 0) !== 1) throw invalid()
  if (tripId && (tripId.length > 200 || !/^[A-Za-z0-9_-]+$/.test(tripId))) throw invalid()
  if (stayId && (!STAY_ID.test(stayId) || !isDay(stayId.slice(-10)))) throw invalid()
  const fuel = (query.fuel?.trim() || "GAZOLE").toUpperCase()
  if (!(FUEL_TYPES as readonly string[]).includes(fuel)) throw invalid()
  // Décisions : valeurs exactes seulement, rien n'est complété ni supposé.
  const rawMode = query.mode?.trim() || null
  if (rawMode !== null && !(TRAVEL_MODES as readonly string[]).includes(rawMode)) throw invalid()
  const gaps: Record<string, GapDecision> = {}
  const rawGaps = query.gaps?.trim() || null
  if (rawGaps !== null) {
    const entries = rawGaps.split(",")
    if (entries.length > MAX_STAY_DAYS) throw invalid()
    for (const entry of entries) {
      const [range, decision, ...rest] = entry.split(":")
      const [from, to, ...more] = (range ?? "").split("..")
      if (rest.length || more.length || !isDay(from ?? "") || !isDay(to ?? "") || to < from || !(GAP_DECISIONS as readonly string[]).includes(decision ?? "") || gaps[range]) throw invalid()
      gaps[range] = decision as GapDecision
    }
  }
  const rawDepot = query.depot?.trim() || null
  if (rawDepot !== null && rawDepot !== "1") throw invalid()
  const rawHandover = query.handover?.trim() || null
  const handover = rawHandover === null ? null : rawHandover.split(",")
  if (handover && (handover.length > MAX_STAY_DAYS + 2 || handover.some((d) => !isDay(d)) || new Set(handover).size !== handover.length)) throw invalid()
  const mode = rawMode as TravelMode | null
  const context = query.context?.trim() || null
  if (context !== null && !/^v1-[0-9a-f]{16}$/.test(context)) throw invalid()
  // Décisions de séjour sur un trajet relevé, ou coupures en mode quotidien : requête incohérente, refusée.
  if (tripId && (mode || rawGaps || handover || context)) throw invalid()
  if (mode === "DAILY" && rawGaps) throw invalid()
  // Une décision de séjour sans le contexte sur lequel elle a été prise ne peut pas être vérifiée : refus.
  if (stayId && (mode || rawGaps || handover) && !context) throw invalid()
  return { tripId, stayId, fuel: fuel as FuelType, mode, gaps, depotConfirmed: rawDepot === "1", handover: handover?.sort() ?? null, context }
}

// ─── Séjours planifiés ───────────────────────────────────────────────────────

const fullName = (e: { firstName: string; lastName: string } | null | undefined) => e ? `${e.firstName} ${e.lastName}`.trim() : null

/**
 * Séjours du camion sur les jours lus `scan` (inclus) : toutes les périodes du camion qui touchent ces jours (instants,
 * convention de la règle pure), jours de planning de ces équipes (refus exclus) lus dans l'ordre (date, id) et bornés
 * à MAX_PLANNING_ROWS lignes — au-delà, le dernier jour partiellement lu est écarté, la lecture est déclarée tronquée et
 * les séjours qui touchent la nouvelle borne n'ont plus de retour connu. Noms d'équipe, de chef et de chauffeur bornés
 * à la société. Sans aucune période enregistrée pour le camion, son équipe et son chauffeur actuels tiennent lieu de
 * période ouverte, signalée comme supposée.
 */
async function loadStays(tx: Tx, scope: { companyId: string; truckId: string }, truck: { teamId: string | null; chauffeurId: string | null }, requested: StayScan, filter?: { teamId: string }) {
  let periods: StayTruckPeriod[] = (await tx.truckAssignment.findMany({
    where: { ...scope, startedAt: { lt: new Date(parisDayStart(addDays(requested.to, 1))) }, OR: [{ endedAt: null }, { endedAt: { gt: new Date(parisDayStart(requested.from)) } }] },
    select: { teamId: true, chauffeurId: true, startedAt: true, endedAt: true },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
  })).map((p) => ({ teamId: p.teamId, chauffeurId: p.chauffeurId, startedAt: p.startedAt.getTime(), endedAt: p.endedAt ? p.endedAt.getTime() : null }))
  if (!periods.length && truck.teamId && await tx.truckAssignment.count({ where: scope }) === 0)
    periods = [{ teamId: truck.teamId, chauffeurId: truck.chauffeurId, startedAt: -8.64e15, endedAt: null, fallback: true }]
  const teamIds = [...new Set(periods.map((p) => p.teamId).filter((id): id is string => !!id))].filter((id) => !filter || id === filter.teamId)
  if (!teamIds.length) return { stays: [] as PlannedStay[], truncated: false }
  const rows = await tx.assignment.findMany({
    where: { teamId: { in: teamIds }, date: { gte: dateColumn(requested.from), lte: dateColumn(requested.to) }, status: { not: "REFUSED" },
      // Tous les chantiers de l'équipe (même pour le détail) : une équipe planifiée ailleurs pendant une coupure coupe le séjour.
      team: { companyId: scope.companyId }, worksite: { companyId: scope.companyId } },
    select: { date: true, teamId: true, worksite: { select: { id: true, name: true, address: true, latitude: true, longitude: true } } },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: MAX_PLANNING_ROWS + 1,
  })
  let scan = requested, kept = rows, truncated = false
  if (rows.length > MAX_PLANNING_ROWS) {
    // Le jour de la dernière ligne peut être incomplet : il est écarté et la borne lue recule d'autant.
    const cutoff = rows[MAX_PLANNING_ROWS - 1].date.toISOString().slice(0, 10)
    kept = rows.filter((r) => r.date.toISOString().slice(0, 10) < cutoff)
    scan = { from: requested.from, to: addDays(cutoff, -1) }
    truncated = true
  }
  const assignments: StayAssignment[] = kept.map((r) => ({ date: r.date.toISOString().slice(0, 10), teamId: r.teamId, worksite: r.worksite }))
  const resolved = scan.to < scan.from ? [] : resolveStays(assignments, periods, scan)
  const teams = await tx.team.findMany({ where: { id: { in: [...new Set(resolved.map((s) => s.teamId))] }, companyId: scope.companyId }, select: { id: true, name: true, leaderId: true } })
  const employeeIds = [...new Set([...teams.map((t) => t.leaderId), ...resolved.map((s) => s.chauffeurId)].filter((id): id is string => !!id))]
  const employees = employeeIds.length ? await tx.employee.findMany({ where: { id: { in: employeeIds }, companyId: scope.companyId }, select: { id: true, firstName: true, lastName: true } }) : []
  const team = new Map(teams.map((t) => [t.id, t])), person = new Map(employees.map((e) => [e.id, e]))
  const stays = resolved.map(({ chauffeurId, ...stay }): PlannedStay => ({
    ...stay, teamName: team.get(stay.teamId)?.name ?? null,
    leaderName: fullName(person.get(team.get(stay.teamId)?.leaderId ?? "")), chauffeurName: chauffeurId ? fullName(person.get(chauffeurId)) : null,
  }))
  return { stays, truncated }
}

/**
 * Séjours planifiés du camion qui touchent aujourd'hui ±60 jours (Paris), du plus récent au plus ancien, avec leurs
 * VRAIES bornes : le planning est lu MAX_STAY_DAYS + STAY_EDGE_DAYS jours de plus de chaque côté, si bien qu'un séjour
 * estimable a ici exactement les dates, coupures et l'identifiant que la lecture du détail reconstruit. Séjour plus long ou bornes inconnues :
 * listé comme non estimable. `partial` : planning tronqué (trop de lignes) ou plus de MAX_STAYS séjours.
 */
export async function listPlannedStays(truckId: string, deps: FuelEstimateDeps): Promise<{ stays: PlannedStay[]; partial: boolean }> {
  gate(deps)
  const session = requireMileageSession(await deps.auth())
  const today = parisDay(deps.now?.() ?? new Date())
  const window = { from: addDays(today, -STAY_WINDOW_DAYS), to: addDays(today, STAY_WINDOW_DAYS) }
  return deps.db.$transaction(async (tx: Tx) => {
    const { truck } = await authorizeVehicleLocked(tx, truckId, session, "READING")
    const margin = MAX_STAY_DAYS + STAY_EDGE_DAYS
    const { stays, truncated } = await loadStays(tx, { companyId: session.companyId, truckId }, truck, { from: addDays(window.from, -margin), to: addDays(window.to, margin) })
    const visible = stays.filter((s) => s.return >= window.from && s.departure <= window.to)
    return { stays: visible.slice(0, MAX_STAYS), partial: truncated || visible.length > MAX_STAYS }
  }, transactionOptions)
}

// ─── Itinéraire et prix ──────────────────────────────────────────────────────

/** Siège → chantier : tracé échantillonné en cache, sinon itinéraire IGN (quota). Null si impossible. */
async function routeFor(deps: FuelEstimateDeps, companyId: string, target: Point): Promise<RouteValue | null> {
  const cacheKey = key(["fuel-route-v4", companyId, PLANNED_MILEAGE_DEPOT.latitude, PLANNED_MILEAGE_DEPOT.longitude, target.latitude.toFixed(5), target.longitude.toFixed(5)])
  const hit = await cached<RouteValue>(deps.db, companyId, cacheKey)
  if (hit) return hit
  try {
    await reserve(deps.db, companyId, "ROUTING")
    const route = await ignRouteGeometry(PLANNED_MILEAGE_DEPOT, target, deps.fetchFn)
    const { samples, radiusKm } = samplePolyline(route.points, CIRCLES_PER_REQUEST * MAX_PRICE_REQUESTS)
    const { line, toleranceKm } = simplifyPolyline(route.points)
    const value: RouteValue = { oneWayKm: Math.round(route.km * 10) / 10, samples, radiusKm, line, toleranceKm }
    await store(deps.db, companyId, cacheKey, value, ROUTE_TTL)
    return value
  } catch (error) {
    if (error instanceof MileageDomainError) return null
    throw error
  }
}

/**
 * Stations du couloir, en au plus 4 requêtes de 40 cercles ; les 8 moins chères et les statistiques sur toutes les
 * stations lues. Chaque requête rend au plus 100 stations (les moins chères) : si l'une est tronquée, les statistiques
 * sont marquées « échantillon » plutôt que présentées comme la médiane du couloir. Aucune requête supplémentaire.
 */
async function stationsFor(deps: FuelEstimateDeps, companyId: string, corridor: Corridor, fuel: FuelType): Promise<StationsValue | null> {
  const cacheKey = key(["fuel-stations-v3", companyId, fuel, corridor.radiusKm, corridor.maxOffRouteKm, corridor.samples.map((p) => [p.latitude.toFixed(4), p.longitude.toFixed(4)])])
  const hit = await cached<StationsValue>(deps.db, companyId, cacheKey)
  if (hit) return hit
  try {
    const found = new Map<string, FuelStation>()
    let sampled = false
    for (let i = 0; i < corridor.samples.length && i < CIRCLES_PER_REQUEST * MAX_PRICE_REQUESTS; i += CIRCLES_PER_REQUEST) {
      await reserve(deps.db, companyId, "ROUTING")
      const result = await stationsInCorridor(corridor.samples.slice(i, i + CIRCLES_PER_REQUEST), corridor.radiusKm, corridor.line, fuel, deps.fetchFn, corridor.maxOffRouteKm)
      sampled ||= result.truncated
      for (const station of result.stations) found.set(station.id, station)
    }
    const all = [...found.values()]
    const value = { stations: rankStations(all), stats: priceStats(all, sampled) }
    await store(deps.db, companyId, cacheKey, value, PRICES_TTL)
    return value
  } catch (error) {
    if (error instanceof MileageDomainError) return null
    throw error
  }
}

// ─── Estimation ──────────────────────────────────────────────────────────────

type Worksite = { name: string; latitude: number | null; longitude: number | null } | null

/**
 * Estimation d'un trajet ou d'un séjour. Pour un séjour, les décisions de l'opérateur (mode, coupures, siège, jours de
 * réaffectation déclarés) sont des hypothèses d'estimation : vérifiées contre le séjour recalculé ici, jamais écrites
 * (lecture seule) ; tant qu'une décision manque, aucun kilométrage n'est rendu. Rien n'est repris du client comme
 * vérité : jours, coupures, allers-retours et kilomètres sont recalculés sous l'autorité de la société.
 */
export async function readFuelEstimate(truckId: string, query: FuelEstimateQuery, deps: FuelEstimateDeps): Promise<FuelEstimate> {
  gate(deps)
  const { tripId, stayId, fuel, mode, gaps: gapChoices, depotConfirmed, handover, context } = parseQuery(query)
  const session = requireMileageSession(await deps.auth())
  const scope = { companyId: session.companyId, truckId }
  const worksiteSelect = { name: true, latitude: true, longitude: true } as const

  const base = await deps.db.$transaction(async (tx: Tx) => {
    const { truck } = await authorizeVehicleLocked(tx, truckId, session, "READING")
    if (stayId) {
      const [worksiteId, teamId, departure] = stayId.split("~")
      // Séjour recalculé avec la même règle et des bornes lues assez larges pour retrouver la liste à l'identique :
      // STAY_EDGE_DAYS avant (une suite plus ancienne s'y rattacherait-elle ?) et jusqu'au plus long séjour plus
      // STAY_EDGE_DAYS après. Identifiant forgé, périmé ou séjour non estimable : refus.
      const { stays } = await loadStays(tx, scope, truck, { from: addDays(departure, -STAY_EDGE_DAYS), to: addDays(departure, MAX_STAY_DAYS + STAY_EDGE_DAYS) }, { teamId })
      const stay = stays.find((s) => s.id === stayId && s.worksiteId === worksiteId)
      if (!stay) throw new MileageDomainError("STAY_NOT_FOUND", 404)
      // Décisions prises sur un autre état du séjour (coupure prolongée, jour ajouté, réaffectation, chauffeur…) : refus,
      // l'opérateur doit actualiser et décider à nouveau. Aucune décision n'est transposée d'un contexte à l'autre.
      if (context !== null && context !== stay.context) throw new MileageDomainError("STAY_CONTEXT_CHANGED", 409)
      // Séjour non estimable : refus explicite par raison (aucune attribution ni retour inventés côté serveur). Seule
      // exception : réaffectation en journée déclarée par l'opérateur pour EXACTEMENT les jours concernés.
      if (stay.blocked === "HANDOVER") {
        if (!handover) throw new MileageDomainError("STAY_HANDOVER", 409)
        if (handover.join(",") !== [...stay.handoverDays].sort().join(",")) throw new MileageDomainError("STAY_HANDOVER_MISMATCH", 409)
      } else if (!stay.estimable) throw new MileageDomainError(stay.blocked === "NO_HISTORY" ? "STAY_NO_HISTORY" : "STAY_INCOMPLETE", 409)
      else if (handover) throw invalid()
      // Coupure inconnue (planning modifié depuis la liste ?) : refus plutôt qu'une décision rattachée au mauvais jour.
      if (Object.keys(gapChoices).some((key) => !stay.gaps.some((g) => gapKey(g) === key))) throw new MileageDomainError("STAY_GAPS_MISMATCH", 409)
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

  // Point du chantier : coordonnées enregistrées uniquement (aucun géocodage d'adresse dans ce parcours).
  let target: Point | null = null
  let routeStatus: RouteStatus = "ROUTE"
  const w = base.worksite
  if (!w) routeStatus = "NO_WORKSITE"
  else if (Number.isFinite(w.latitude) && Number.isFinite(w.longitude)) target = { latitude: w.latitude!, longitude: w.longitude! }
  else routeStatus = "NO_COORDINATES"

  const depotKnown = hasPlannedMileageDepot(session.companyId)
  let route: RouteValue | null = null
  if (target && depotKnown) { route = await routeFor(deps, session.companyId, target); if (!route) routeStatus = "UNAVAILABLE" }
  else if (target) routeStatus = "NO_DEPOT"

  let stationsStatus: StationsStatus
  let corridor: Corridor | null
  if (route) { stationsStatus = "ROUTE_CORRIDOR"; corridor = { samples: route.samples, radiusKm: route.radiusKm, line: route.line, maxOffRouteKm: Math.round((CORRIDOR_HALF_WIDTH_KM + (route.toleranceKm ?? 0)) * 100) / 100 } }
  else if (target) { stationsStatus = "NEAR_WORKSITE"; corridor = { samples: [target], radiusKm: NEAR_RADIUS_KM, line: [target], maxOffRouteKm: NEAR_RADIUS_KM } }
  else if (depotKnown) { const depot = { latitude: PLANNED_MILEAGE_DEPOT.latitude, longitude: PLANNED_MILEAGE_DEPOT.longitude }; stationsStatus = "NEAR_DEPOT"; corridor = { samples: [depot], radiusKm: NEAR_RADIUS_KM, line: [depot], maxOffRouteKm: NEAR_RADIUS_KM } }
  else { stationsStatus = "NONE"; corridor = null }
  let found: StationsValue = { stations: [], stats: null }
  if (corridor) {
    const value = await stationsFor(deps, session.companyId, corridor, fuel)
    if (value) found = value
    else stationsStatus = "UNAVAILABLE"
  }

  // Kilomètres : compteur, sinon itinéraire × allers-retours — seulement avec le siège confirmé comme vrai point de
  // départ et, pour un séjour, le mode et chaque coupure décidés. Sinon aucun kilométrage (donc aucun montant).
  const missing: EstimateDecision[] = []
  let travel: StayTravel | null = null
  let roundTrips: number | null = base.source === "TRIP" ? 1 : null
  if (base.stay) {
    const result = stayRoundTrips(base.stay, { mode, gaps: gapChoices })
    missing.push(...result.missing)
    roundTrips = result.roundTrips
    travel = { context: base.stay.context, mode, gaps: result.gaps, plannedDays: base.stay.days, roundTrips, oneWayKm: route?.oneWayKm ?? null, handoverDeclared: base.stay.blocked === "HANDOVER" ? [...base.stay.handoverDays].sort() : [] }
  }
  if (base.km === null && route && !depotConfirmed) missing.push("DEPOT")
  const routeKm = route && depotConfirmed && roundTrips !== null && !missing.length ? Math.round(route.oneWayKm * 2 * roundTrips) : null
  const km = base.km !== null ? base.km : routeKm
  const kmSource = base.km !== null ? "ODOMETER" as const : routeKm !== null ? (base.source === "STAY" ? "STAY_ROUND_TRIP" as const : "ROUTE_ROUND_TRIP" as const) : null
  return {
    source: base.source, tripId: base.id, stay: base.stay, tripDate: base.date, tripClosed: base.closed, worksiteName: base.worksiteName, odometer: base.odometer,
    km, kmSource, route: { status: routeStatus, oneWayKm: route?.oneWayKm ?? null }, fuel,
    stations: found.stations, stationsStatus, priceStats: found.stats,
    travel, depotConfirmed, missing,
  }
}
