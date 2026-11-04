/**
 * Kilométrage prévu par chantier (lecture seule, derrière PLANIFICATOR_VEHICLE_PLANNED_MILEAGE_ENABLED).
 * Autorisation et lecture du planning dans une transaction courte ; appels IGN hors transaction.
 * Distances mises en cache par société dans vehicle_cartography_cache ; jamais d'écriture au journal du compteur.
 */
import { createHash } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import { MileageDomainError } from "./mileage-domain"
import { requireMileageSession, type MileageSession } from "./mileage-access"
import { authorizeVehicleLocked } from "./vehicle-authority"
import { normalizeMileageFailure } from "./mileage-service"
import { reserveImportProvider } from "./import-provider-quota"
import {
  CROW_FLIGHT_DETOUR_FACTOR, PLANNED_MILEAGE_DEPOT, PLANNED_MILEAGE_MARGIN_KM, crowFlightKm, isPlannedMileageEnabled,
  parsePlannedMonth, plannedTripKm, resolvePlannedWorksites,
  type DistanceSource, type PlannedPeriod, type PlannedWorksite, type PlannedWorksiteDays, type Point, type TruckTeamPeriod,
} from "./planned-mileage-domain"
import { ignGeocode, ignRouteKm } from "./planned-mileage-ign"

export interface PlannedMileageDeps {
  auth: () => Promise<MileageSession | null>
  db: PrismaClient
  now?: () => Date
  fetchFn?: typeof fetch
  env?: Record<string, string | undefined>
}

export type UnresolvedReason = "ADDRESS_MISSING" | "ADDRESS_NOT_FOUND" | "GEOCODING_UNAVAILABLE"
export type OneWayDistance = { oneWayKm: number; source: DistanceSource } | { unresolved: UnresolvedReason }
export type DistanceResolver = (worksite: PlannedWorksite) => Promise<OneWayDistance>

export interface PlannedMileageLine {
  worksiteId: string
  worksiteName: string
  address: string | null
  days: number
  firstDay: string
  lastDay: string
  oneWayKm: number
  roundTripKm: number
  marginKm: number
  totalKm: number
  source: DistanceSource
}

export interface PlannedMileageReport {
  truckId: string
  month: string
  depot: string
  marginKm: number
  lines: PlannedMileageLine[]
  unresolved: { worksiteId: string; worksiteName: string; days: number; reason: UnresolvedReason }[]
  totalKm: number
}

const ROUTE_TTL = "30 days"
const ESTIMATE_TTL = "1 hour"
const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 }

/** Assemble le rapport ; les chantiers sont résolus un par un pour rester sous les limites du service public. */
export async function buildPlannedMileage(truckId: string, month: string, groups: PlannedWorksiteDays[], resolve: DistanceResolver): Promise<PlannedMileageReport> {
  const lines: PlannedMileageLine[] = []
  const unresolved: PlannedMileageReport["unresolved"] = []
  for (const { worksite, days } of groups) {
    const distance = await resolve(worksite)
    if ("unresolved" in distance) {
      unresolved.push({ worksiteId: worksite.id, worksiteName: worksite.name, days: days.length, reason: distance.unresolved })
      continue
    }
    lines.push({
      worksiteId: worksite.id, worksiteName: worksite.name, address: worksite.address,
      days: days.length, firstDay: days[0], lastDay: days[days.length - 1],
      oneWayKm: Math.round(distance.oneWayKm * 10) / 10, source: distance.source, ...plannedTripKm(distance.oneWayKm),
    })
  }
  return {
    truckId, month, depot: PLANNED_MILEAGE_DEPOT.label, marginKm: PLANNED_MILEAGE_MARGIN_KM,
    lines, unresolved, totalKm: lines.reduce((sum, line) => sum + line.totalKm, 0),
  }
}

function hasCoordinates(w: PlannedWorksite): w is PlannedWorksite & Point {
  return Number.isFinite(w.latitude) && Number.isFinite(w.longitude)
}

/** Distance siège → chantier : cache, sinon itinéraire IGN, sinon vol d'oiseau majoré (mis en cache brièvement). */
export function cachedDistanceResolver(db: PrismaClient, companyId: string, fetchFn: typeof fetch = fetch): DistanceResolver {
  return async (worksite) => {
    const address = worksite.address?.trim().replace(/\s+/g, " ") ?? ""
    if (!hasCoordinates(worksite) && !address) return { unresolved: "ADDRESS_MISSING" }
    const key = createHash("sha256").update(JSON.stringify([
      "planned-mileage-v1", companyId, PLANNED_MILEAGE_DEPOT.latitude, PLANNED_MILEAGE_DEPOT.longitude,
      worksite.latitude, worksite.longitude, address.toLowerCase(),
    ])).digest("hex")
    const hit = await db.$queryRaw<{ value: { oneWayKm: number; source: DistanceSource } }[]>`
      SELECT "value" FROM "vehicle_cartography_cache" WHERE "key" = ${key} AND "companyId" = ${companyId} AND "expiresAt" > clock_timestamp()`
    if (hit.length) return hit[0].value

    let target: Point | null = hasCoordinates(worksite) ? worksite : null
    if (!target) {
      try {
        await db.$transaction((tx) => reserveImportProvider(tx, companyId, "GEOCODING"), transactionOptions)
        target = await ignGeocode(address, fetchFn)
      } catch (error) {
        if (error instanceof MileageDomainError) return { unresolved: "GEOCODING_UNAVAILABLE" }
        throw error
      }
      if (!target) return { unresolved: "ADDRESS_NOT_FOUND" }
    }

    let value: { oneWayKm: number; source: DistanceSource }
    try {
      await db.$transaction((tx) => reserveImportProvider(tx, companyId, "ROUTING"), transactionOptions)
      value = { oneWayKm: await ignRouteKm(PLANNED_MILEAGE_DEPOT, target, fetchFn), source: "ROUTE" }
    } catch (error) {
      if (!(error instanceof MileageDomainError)) throw error
      value = { oneWayKm: crowFlightKm(PLANNED_MILEAGE_DEPOT, target) * CROW_FLIGHT_DETOUR_FACTOR, source: "ESTIMATE" }
    }
    const ttl = value.source === "ROUTE" ? ROUTE_TTL : ESTIMATE_TTL
    await db.$executeRaw`INSERT INTO "vehicle_cartography_cache" ("key","companyId","value","expiresAt")
      VALUES (${key}, ${companyId}, ${JSON.stringify(value)}::jsonb, clock_timestamp() + ${ttl}::interval)
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "expiresAt" = EXCLUDED."expiresAt"`
    return value
  }
}

type PlanningReader = {
  truckAssignment: Pick<Prisma.TransactionClient["truckAssignment"], "findMany" | "count">
  assignment: Pick<Prisma.TransactionClient["assignment"], "findMany">
}

/**
 * Périodes du camion qui chevauchent le mois à Paris, puis jours de planning de leurs équipes.
 * L'équipe actuelle ne remplace l'historique que si le camion n'a aucune période enregistrée :
 * un mois sans période (camion créé plus tard, ou sans équipe) reste vide.
 */
export async function loadPlannedWorksites(tx: PlanningReader, scope: { truckId: string; companyId: string }, period: PlannedPeriod, currentTeamId: string | null): Promise<PlannedWorksiteDays[]> {
  let periods: TruckTeamPeriod[] = await tx.truckAssignment.findMany({
    where: { ...scope, startedAt: { lt: period.parisEnd }, OR: [{ endedAt: null }, { endedAt: { gte: period.parisStart } }] },
    select: { teamId: true, startedAt: true, endedAt: true },
  })
  if (!periods.length) {
    if (!currentTeamId || await tx.truckAssignment.count({ where: scope }) > 0) return []
    periods = [{ teamId: currentTeamId, startedAt: new Date(0), endedAt: null }]
  }
  const teamIds = [...new Set(periods.map((p) => p.teamId).filter((id): id is string => id !== null))]
  if (!teamIds.length) return []
  const assignments = await tx.assignment.findMany({
    where: {
      teamId: { in: teamIds }, date: { gte: period.start, lt: period.end }, status: { not: "REFUSED" },
      team: { companyId: scope.companyId }, worksite: { companyId: scope.companyId },
    },
    select: { date: true, teamId: true, worksite: { select: { id: true, name: true, address: true, latitude: true, longitude: true } } },
  })
  return resolvePlannedWorksites(assignments, periods)
}

export async function readPlannedMileage(truckId: string, rawMonth: string | null, deps: PlannedMileageDeps, resolverFor = cachedDistanceResolver): Promise<PlannedMileageReport> {
  if (!isPlannedMileageEnabled(deps.env)) throw new MileageDomainError("FEATURE_DISABLED", 404)
  const session = requireMileageSession(await deps.auth())
  const period = parsePlannedMonth(rawMonth, deps.now?.() ?? new Date())
  let groups: PlannedWorksiteDays[]
  try {
    groups = await deps.db.$transaction(async (tx) => {
      const { truck } = await authorizeVehicleLocked(tx, truckId, session, "READ")
      return loadPlannedWorksites(tx, { truckId, companyId: session.companyId }, period, truck.teamId)
    }, transactionOptions)
  } catch (error) {
    return normalizeMileageFailure(error)
  }
  return buildPlannedMileage(truckId, period.month, groups, resolverFor(deps.db, session.companyId, deps.fetchFn))
}
