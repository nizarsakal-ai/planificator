import { createHash } from "node:crypto"
import { authorizeVehicleLocked } from "./vehicle-authority"
/** Entretien V2 : autorité métier transactionnelle, tenant issu de la session uniquement. */
import { Prisma } from "@prisma/client"
import { MileageDomainError } from "./mileage-domain"
import { requireMileageSession } from "./mileage-access"
import { normalizeMileageFailure, type MileageServiceDeps } from "./mileage-service"
import { effectiveMaintenanceEntries, parseMaintenanceCorrection, maintenanceHash, maintenanceSummary, parseMaintenanceEntry, parseMaintenancePlan, validateMaintenanceEntry } from "./maintenance-domain"
export type MaintenanceServiceDeps = MileageServiceDeps
type Tx = Prisma.TransactionClient

const transactionOptions = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 }


const planDto = (plan: { intervalKm: number | null; intervalMonths: number | null; revision: number; updatedAt: Date; updatedByNameSnapshot: string } | null) => plan ? ({
  intervalKm: plan.intervalKm, intervalMonths: plan.intervalMonths, revision: plan.revision,
  updatedAt: plan.updatedAt.toISOString(), updatedByName: plan.updatedByNameSnapshot,
}) : null
async function databaseNow(tx: Tx) {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS "now"`
  if (!(rows[0]?.now instanceof Date)) throw new MileageDomainError("SERVER_ERROR", 500)
  return rows[0].now
}
export async function readMaintenance(truckId: string, deps: MaintenanceServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  try {
    return await deps.db.$transaction(async tx => {
      const { truck } = await authorizeVehicleLocked(tx, truckId, session, "READ")
      const scope = { companyId: session.companyId, truckId }
      const plan = await tx.vehicleMaintenancePlan.findFirst({ where: scope })
      const history = await tx.vehicleMaintenanceEntry.findMany({ where: scope, orderBy: [{ occurredAt: "desc" }, { recordedAt: "desc" }, { id: "desc" }] })
      const superseded = new Set(history.map(entry => entry.supersedesEntryId).filter(Boolean))
      return { truckId, currentMileage: truck.currentMileage, plan: planDto(plan),
        summary: maintenanceSummary(plan, history, truck.currentMileage, await databaseNow(tx)),
        history: history.map(entry => ({ id: entry.id, kind: entry.kind, occurredAt: entry.occurredAt.toISOString(),
          mileage: entry.mileage, notes: entry.notes, recordedAt: entry.recordedAt.toISOString(), createdByName: entry.createdByNameSnapshot, supersedesEntryId: entry.supersedesEntryId, correctionReason: entry.correctionReason, isEffective: !superseded.has(entry.id) })) }
    }, transactionOptions)
  } catch (error) { return normalizeMileageFailure(error) }
}
export async function recordMaintenance(truckId: string, body: unknown, key: string | null, deps: MaintenanceServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  const input = parseMaintenanceEntry(body, key)
  const requestHash = maintenanceHash(input, session.companyId, truckId, session.userId)
  try {
    return await deps.db.$transaction(async tx => {
      const { truck, actor } = await authorizeVehicleLocked(tx, truckId, session, "READING")
      const scope = { companyId: session.companyId, truckId }
      const previous = await tx.vehicleMaintenanceEntry.findFirst({ where: { ...scope, idempotencyKey: input.idempotencyKey } })
      if (previous) {
        if (previous.requestHash !== requestHash) throw new MileageDomainError("IDEMPOTENCY_CONFLICT", 409)
        return { entryId: previous.id, replayed: true }
      }
      if (!truck.active) throw new MileageDomainError("TRUCK_ARCHIVED", 409)
      const history = await tx.vehicleMaintenanceEntry.findMany({ where: scope })
      const recordedAt = await databaseNow(tx)
      validateMaintenanceEntry(input, effectiveMaintenanceEntries(history), truck.currentMileage, recordedAt)
      const entry = await tx.vehicleMaintenanceEntry.create({ data: { ...scope, ...input, requestHash, recordedAt,
        createdById: actor.id, createdByNameSnapshot: actor.name?.trim() || actor.id } })
      return { entryId: entry.id, replayed: false }
    }, transactionOptions)
  } catch (error) { return normalizeMileageFailure(error) }
}
export async function updateMaintenancePlan(truckId: string, body: unknown, deps: MaintenanceServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  const input = parseMaintenancePlan(body)
  try {
    return await deps.db.$transaction(async tx => {
      const { truck, actor } = await authorizeVehicleLocked(tx, truckId, session, "READING")
      if (!truck.active) throw new MileageDomainError("TRUCK_ARCHIVED", 409)
      const scope = { companyId: session.companyId, truckId }
      const previous = await tx.vehicleMaintenancePlan.findFirst({ where: scope })
      // Identical repeated PUT is harmless even if the response was lost.
      if (previous && previous.intervalKm === input.intervalKm && previous.intervalMonths === input.intervalMonths
        && input.expectedRevision === previous.revision - 1) return planDto(previous)
      if ((previous?.revision ?? 0) !== input.expectedRevision)
        throw new MileageDomainError("MAINTENANCE_PLAN_CONFLICT", 409)
      const data = { intervalKm: input.intervalKm, intervalMonths: input.intervalMonths,
        revision: input.expectedRevision + 1, updatedById: actor.id, updatedByNameSnapshot: actor.name?.trim() || actor.id }
      const plan = previous
        ? await tx.vehicleMaintenancePlan.update({ where: { id: previous.id }, data })
        : await tx.vehicleMaintenancePlan.create({ data: { ...scope, ...data } })
      return planDto(plan)
    }, transactionOptions)
  } catch (error) { return normalizeMileageFailure(error) }
}
export type MaintenanceReadDto = Awaited<ReturnType<typeof readMaintenance>>

/** Admit correction rights before reading a request body; commit rechecks the same authority. */
export async function preauthorizeMaintenanceCorrection(truckId: string, entryId: string, deps: MaintenanceServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  await deps.db.$transaction(async tx => {
    const { truck } = await authorizeVehicleLocked(tx, truckId, session, "READING")
    if (!truck.active) throw new MileageDomainError("TRUCK_ARCHIVED", 409)
    if (!await tx.vehicleMaintenanceEntry.findFirst({ where: { id: entryId, truckId, companyId: session.companyId } })) throw new MileageDomainError("MAINTENANCE_ENTRY_NOT_FOUND", 404)
  }, transactionOptions)
}

/** Amend an intervention by appending a version; never rewrite its evidence or history. */
export async function correctMaintenance(truckId: string, entryId: string, body: unknown, key: string | null, deps: MaintenanceServiceDeps) {
  const session = requireMileageSession(await deps.auth())
  const input = parseMaintenanceCorrection(body, key)
  const requestHash = createHash("sha256").update(JSON.stringify([maintenanceHash(input, session.companyId, truckId, session.userId), entryId, input.reason])).digest("hex")
  try {
    return await deps.db.$transaction(async tx => {
      const { truck, actor } = await authorizeVehicleLocked(tx, truckId, session, "READING")
      const scope = { companyId: session.companyId, truckId }
      const previous = await tx.vehicleMaintenanceEntry.findFirst({ where: { ...scope, idempotencyKey: input.idempotencyKey } })
      if (previous) {
        if (previous.requestHash !== requestHash) throw new MileageDomainError("IDEMPOTENCY_CONFLICT", 409)
        return { entryId: previous.id, replayed: true }
      }
      if (!truck.active) throw new MileageDomainError("TRUCK_ARCHIVED", 409)
      const history = await tx.vehicleMaintenanceEntry.findMany({ where: scope })
      const target = history.find(entry => entry.id === entryId)
      if (!target) throw new MileageDomainError("MAINTENANCE_ENTRY_NOT_FOUND", 404)
      if (history.some(entry => entry.supersedesEntryId === entryId)) throw new MileageDomainError("MAINTENANCE_CORRECTION_CONFLICT", 409)
      const recordedAt = await databaseNow(tx)
      validateMaintenanceEntry(input, effectiveMaintenanceEntries(history).filter(entry => entry.id !== entryId), truck.currentMileage, recordedAt)
      const { reason, ...values } = input
      const saved = await tx.vehicleMaintenanceEntry.create({ data: { ...scope, ...values, requestHash, recordedAt,
        supersedesEntryId: entryId, correctionReason: reason, createdById: actor.id, createdByNameSnapshot: actor.name?.trim() || actor.id } })
      return { entryId: saved.id, replayed: false }
    }, transactionOptions)
  } catch (error) {
    const detail = error as { code?: string; meta?: { target?: unknown; constraint?: unknown } }
    if (detail?.code === "P2002" && /supersedesEntryId/.test(String(detail.meta?.target ?? detail.meta?.constraint)))
      throw new MileageDomainError("MAINTENANCE_CORRECTION_CONFLICT", 409)
    return normalizeMileageFailure(error)
  }
}
