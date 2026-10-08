/**
 * Vehicles V2 Lot 1: service serveur injecté, sans route publique ni connexion globale.
 * Toutes les mutations d'un véhicule partagent son verrou PostgreSQL avec V1.
 */
import { Prisma, type PrismaClient, type MileageEntry, type Truck } from "@prisma/client"
import {
  computeMileageRequestHash, getMileageTripDistance, MAX_MILEAGE_REVISION,
  MileageDomainError, parseMileageCommand, rebuildMileageProjection, resolveMileageHistory,
  validateMileageCorrection, validateNewOriginal,
  type MileageCommand, type MileageCommandType, type MileageProjection,
} from "./mileage-domain"
import {
  assertMileageAccess, requireMileageSession,
  type MileageAction, type MileageActor, type MileageSession,
} from "./mileage-access"

export interface MileageServiceDeps {
  auth: () => Promise<MileageSession | null>
  db: Pick<PrismaClient, "$transaction">
}

export interface MileageReceipt {
  entryId: string
  acceptedRevision: number
  tripId?: string
  rootEntryId?: string
}

type Tx = Prisma.TransactionClient
type Session = ReturnType<typeof requireMileageSession>
type TeamContext = { id: string; companyId: string; leaderId: string; active: boolean; name: string }
type EmployeeContext = { id: string; userId: string; companyId: string; active: boolean }

const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 }

async function authorizeLocked(tx: Tx, truckId: string, session: Session, action: MileageAction) {
  // Deux instructions distinctes : la lecture métier intervient APRÈS l'attente du verrou.
  const locked = action === "READ"
    ? await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "trucks" WHERE "id" = ${truckId} AND "companyId" = ${session.companyId} FOR SHARE`
    : await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "trucks" WHERE "id" = ${truckId} AND "companyId" = ${session.companyId} FOR UPDATE`
  if (!locked.length) throw new MileageDomainError("TRUCK_NOT_FOUND", 404)
  const truck = await tx.truck.findFirst({ where: { id: truckId, companyId: session.companyId } })
  if (!truck) throw new MileageDomainError("TRUCK_NOT_FOUND", 404)

  const users = await tx.$queryRaw<MileageActor[]>`
    SELECT "id", "role"::text AS "role", "companyId", "active", "name" FROM "users"
    WHERE "id" = ${session.userId}
      AND ("companyId" = ${session.companyId} OR ("role" = 'SUPER_ADMIN' AND "companyId" IS NULL))
    FOR SHARE`
  const actor = users[0]
  if (!actor) throw new MileageDomainError("UNAUTHENTICATED", 401)

  const employees = actor.role === "TEAM_LEADER"
    ? await tx.$queryRaw<EmployeeContext[]>`
      SELECT "id", "userId", "companyId", "active" FROM "employees"
      WHERE "userId" = ${actor.id} AND "companyId" = ${session.companyId} FOR SHARE`
    : []
  const teams = truck.teamId
    ? await tx.$queryRaw<TeamContext[]>`
      SELECT "id", "companyId", "leaderId", "active", "name" FROM "teams"
      WHERE "id" = ${truck.teamId} AND "companyId" = ${session.companyId} FOR SHARE`
    : []
  const team = teams[0] ?? null
  assertMileageAccess(action, {
    companyId: session.companyId, sessionRole: session.role,
    actor, truck, employee: employees[0] ?? null, team,
  })
  return { truck, actor, team }
}

function assertProjection(truck: Truck, projection: MileageProjection) {
  if (truck.currentMileage !== projection.currentMileage
    || truck.currentMileageEntryId !== projection.currentMileageEntryId
    || truck.mileageRevision !== projection.mileageRevision)
    throw new MileageDomainError("MILEAGE_PROJECTION_CONFLICT", 500)
}

async function receiptFor(tx: Tx, entry: MileageEntry): Promise<MileageReceipt> {
  const receipt: MileageReceipt = { entryId: entry.id, acceptedRevision: entry.revision }
  if (entry.kind === "CORRECTION") {
    if (!entry.rootEntryId) throw new MileageDomainError("MILEAGE_HISTORY_CORRUPT", 500)
    receipt.rootEntryId = entry.rootEntryId
  }
  if (entry.kind === "DEPARTURE" || entry.kind === "ARRIVAL") {
    const trip = await tx.mileageTrip.findFirst({
      where: {
        companyId: entry.companyId, truckId: entry.truckId,
        ...(entry.kind === "DEPARTURE" ? { startEntryId: entry.id } : { endEntryId: entry.id }),
      },
      select: { id: true },
    })
    if (!trip) throw new MileageDomainError("MILEAGE_HISTORY_CORRUPT", 500)
    receipt.tripId = trip.id
  }
  return receipt
}

/** Ne copie que les labels nécessaires, après contrôle des références du tenant. */
async function departureContext(tx: Tx, truck: Truck, team: TeamContext | null, command: Extract<MileageCommand, { type: "START" }>) {
  if (truck.teamId && !team) throw new MileageDomainError("TEAM_NOT_FOUND", 404)
  const drivers = truck.chauffeurId
    ? await tx.$queryRaw<{ id: string; firstName: string; lastName: string }[]>`
      SELECT "id", "firstName", "lastName" FROM "employees"
      WHERE "id" = ${truck.chauffeurId} AND "companyId" = ${truck.companyId} FOR SHARE`
    : []
  const driver = drivers[0]
  if (truck.chauffeurId && !driver) throw new MileageDomainError("DRIVER_NOT_FOUND", 404)
  const worksites = command.worksiteId
    ? await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT "id", "name" FROM "worksites"
      WHERE "id" = ${command.worksiteId} AND "companyId" = ${truck.companyId} FOR SHARE`
    : []
  const worksite = worksites[0]
  if (command.worksiteId && !worksite) throw new MileageDomainError("WORKSITE_NOT_FOUND", 404)
  return {
    teamId: team?.id ?? null,
    teamNameSnapshot: team ? team.name.trim() || team.id : null,
    chauffeurId: driver?.id ?? null,
    chauffeurNameSnapshot: driver ? `${driver.firstName} ${driver.lastName}`.trim() || driver.id : null,
    worksiteId: worksite?.id ?? null,
    worksiteNameSnapshot: worksite ? worksite.name.trim() || worksite.id : null,
  }
}

/** Classifie seulement les erreurs techniques connues; aucun message SQL brut n'est exposé. */
export function normalizeMileageFailure(error: unknown): never {
  if (error instanceof MileageDomainError) throw error
  const e = error as { code?: string; meta?: { code?: string; target?: unknown; database_error?: unknown; constraint?: unknown }; message?: string } | null
  const code = e?.meta?.code ?? e?.code
  if (["P2028", "P2034", "40P01", "40001", "55P03"].includes(code ?? ""))
    throw new MileageDomainError("CONCURRENT_UPDATE", 409)
  const detail = [e?.meta?.target, e?.meta?.constraint, e?.meta?.database_error, e?.message].map(String).join(" ")
  if (e?.code === "P2002" || code === "23505") {
    if (/supersedesEntryId|mileage_entries_supersedes_truck_company_key/.test(detail)) throw new MileageDomainError("MILEAGE_CORRECTION_CONFLICT", 409)
    // Course d'idempotence : la transaction perdante est déjà annulée. Ce chemin ne relit
    // pas le gagnant et ne rejoue pas le reçu. Un appel suivant, une fois la ligne visible,
    // emprunte le replay. La course réelle reste à prouver sous PostgreSQL.
    if (/idempotencyKey|mileage_entries_company_truck_idempotency_key/.test(detail)) throw new MileageDomainError("IDEMPOTENCY_CONFLICT", 409)
    if (/mileage_trips.*open/.test(detail)) throw new MileageDomainError("TRIP_ALREADY_OPEN", 409)
    if (/revision/.test(detail)) throw new MileageDomainError("MILEAGE_REVISION_CONFLICT", 409)
  }
  if ((code === "23514" || e?.code === "P2004") && /trucks_v2_no_open_mileage_trip_check/.test(detail))
    throw new MileageDomainError("TRUCK_HAS_OPEN_TRIP", 409)
  throw error
}

export async function executeMileageCommand(
  truckId: string,
  type: MileageCommandType,
  body: unknown,
  idempotencyKey: string | null,
  deps: MileageServiceDeps,
): Promise<{ receipt: MileageReceipt; replayed: boolean; status: number }> {
  const session = requireMileageSession(await deps.auth())
  const command = parseMileageCommand(type, body, idempotencyKey)
  const requestHash = computeMileageRequestHash(command, { companyId: session.companyId, truckId, actorId: session.userId })
  try {
    return await deps.db.$transaction(async (tx) => {
      const { truck, actor, team } = await authorizeLocked(tx, truckId, session, command.type)
      const scope = { companyId: session.companyId, truckId }
      // Le droit courant est vérifié avant replay, la révision APRÈS replay.
      const previous = await tx.mileageEntry.findFirst({ where: { ...scope, idempotencyKey: command.idempotencyKey } })
      const status = command.type === "END" ? 200 : 201
      if (previous) {
        if (previous.requestHash !== requestHash) throw new MileageDomainError("IDEMPOTENCY_CONFLICT", 409)
        return { receipt: await receiptFor(tx, previous), replayed: true, status }
      }
      if (truck.mileageRevision !== command.expectedRevision)
        throw new MileageDomainError("MILEAGE_REVISION_CONFLICT", 409)
      if (truck.mileageRevision >= MAX_MILEAGE_REVISION) throw new MileageDomainError("MILEAGE_REVISION_EXHAUSTED", 409)
      if (!truck.active && command.type !== "CORRECTION") throw new MileageDomainError("TRUCK_ARCHIVED", 409)

      const entries = await tx.mileageEntry.findMany({ where: scope, orderBy: { revision: "asc" } })
      const trips = await tx.mileageTrip.findMany({ where: scope })
      const history = resolveMileageHistory(entries)
      assertProjection(truck, history.projection)
      for (const trip of trips) getMileageTripDistance(history, trip)
      let rootEntryId: string | null = null
      let supersedesEntryId: string | null = null
      let occurredAt: Date | null = null
      let context: Awaited<ReturnType<typeof departureContext>> | undefined
      let endingTrip: (typeof trips)[number] | undefined

      if (command.type === "CORRECTION") {
        const target = validateMileageCorrection(history, command, trips)
        rootEntryId = target.original.id
        supersedesEntryId = target.effective.id
      } else {
        if (command.type === "START") {
          if (trips.some((trip) => trip.endEntryId === null)) throw new MileageDomainError("TRIP_ALREADY_OPEN", 409)
          context = await departureContext(tx, truck, team, command)
        }
        if (command.type === "END") {
          endingTrip = trips.find((trip) => trip.id === command.tripId)
          if (!endingTrip) throw new MileageDomainError("TRIP_NOT_FOUND", 404)
          if (endingTrip.endEntryId !== null) throw new MileageDomainError("TRIP_ALREADY_CLOSED", 409)
          const departure = history.byOriginalId.get(endingTrip.startEntryId)
          if (!departure) throw new MileageDomainError("MILEAGE_HISTORY_CORRUPT", 500)
          if (command.mileage < departure.effective.mileage)
            throw new MileageDomainError("ARRIVAL_BELOW_DEPARTURE", 409)
        }
        const times = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS "now"`
        const now = times[0]?.now
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new MileageDomainError("SERVER_ERROR", 500)
        occurredAt = command.occurredAt ?? now
        validateNewOriginal(history, command.mileage, occurredAt, now)
      }

      const entry = await tx.mileageEntry.create({ data: {
        ...scope,
        kind: command.type === "START" ? "DEPARTURE" : command.type === "END" ? "ARRIVAL" : command.type,
        mileage: command.mileage,
        revision: truck.mileageRevision + 1,
        occurredAt,
        createdById: actor.id,
        createdByNameSnapshot: actor.name?.trim() || actor.id,
        rootEntryId,
        supersedesEntryId,
        correctionReason: command.type === "CORRECTION" ? command.reason : null,
        idempotencyKey: command.idempotencyKey,
        requestHash,
      } })

      if (command.type === "START") {
        if (!context) throw new MileageDomainError("SERVER_ERROR", 500)
        await tx.mileageTrip.create({ data: { ...scope, startEntryId: entry.id, ...context } })
      }
      if (endingTrip) {
        const ended = await tx.mileageTrip.updateMany({
          where: { ...scope, id: endingTrip.id, endEntryId: null }, data: { endEntryId: entry.id },
        })
        if (ended.count !== 1) throw new MileageDomainError("TRIP_ALREADY_CLOSED", 409)
      }
      const projection = rebuildMileageProjection([...entries, entry])
      const updated = await tx.truck.updateMany({
        where: { id: truckId, companyId: session.companyId, mileageRevision: truck.mileageRevision },
        data: projection,
      })
      if (updated.count !== 1) throw new MileageDomainError("MILEAGE_REVISION_CONFLICT", 409)
      return { receipt: await receiptFor(tx, entry), replayed: false, status }
    }, transactionOptions)
  } catch (error) {
    return normalizeMileageFailure(error)
  }
}

/** Lecture cœur Lot 1. Pas de route publique; pagination UI/API à intégrer au Lot 2. */
export async function readMileage(truckId: string, deps: MileageServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  try {
    return await deps.db.$transaction(async (tx) => {
      const { truck } = await authorizeLocked(tx, truckId, session, "READ")
      const scope = { companyId: session.companyId, truckId }
      const entries = await tx.mileageEntry.findMany({ where: scope, orderBy: { revision: "asc" } })
      const trips = await tx.mileageTrip.findMany({ where: scope })
      const resolved = resolveMileageHistory(entries)
      assertProjection(truck, resolved.projection)
      const tripDtos = trips.map((trip) => ({
        id: trip.id, startEntryId: trip.startEntryId, endEntryId: trip.endEntryId,
        distance: getMileageTripDistance(resolved, trip),
        worksiteId: trip.worksiteId, worksiteName: trip.worksiteNameSnapshot,
        teamId: trip.teamId, teamName: trip.teamNameSnapshot,
        chauffeurId: trip.chauffeurId, chauffeurName: trip.chauffeurNameSnapshot,
      }))
      return {
        truckId, ...resolved.projection,
        openTrip: tripDtos.find((trip) => trip.endEntryId === null) ?? null,
        trips: tripDtos,
        history: entries.map((entry) => ({
          id: entry.id, kind: entry.kind, mileage: entry.mileage, revision: entry.revision,
          occurredAt: entry.occurredAt?.toISOString() ?? null,
          recordedAt: entry.recordedAt.toISOString(),
          createdById: entry.createdById, createdByName: entry.createdByNameSnapshot,
          rootEntryId: entry.rootEntryId, supersedesEntryId: entry.supersedesEntryId,
          correctionReason: entry.correctionReason,
        })),
      }
    }, transactionOptions)
  } catch (error) {
    return normalizeMileageFailure(error)
  }
}
