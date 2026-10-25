import { authorizeVehicleLocked } from "./vehicle-authority"
/** Entretien V2 : autorité métier transactionnelle, tenant issu de la session uniquement. */
import { Prisma } from "@prisma/client"
import { MileageDomainError } from "./mileage-domain"
import { requireMileageSession } from "./mileage-access"
import { normalizeMileageFailure, type MileageServiceDeps } from "./mileage-service"
import { maintenanceHash, maintenanceSummary, parseMaintenanceEntry, parseMaintenancePlan, validateMaintenanceEntry } from "./maintenance-domain"
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
      return { truckId, currentMileage: truck.currentMileage, plan: planDto(plan),
        summary: maintenanceSummary(plan, history, truck.currentMileage, await databaseNow(tx)),
        history: history.map(entry => ({ id: entry.id, kind: entry.kind, occurredAt: entry.occurredAt.toISOString(),
          mileage: entry.mileage, notes: entry.notes, recordedAt: entry.recordedAt.toISOString(), createdByName: entry.createdByNameSnapshot })) }
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
      validateMaintenanceEntry(input, history, truck.currentMileage, recordedAt)
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
