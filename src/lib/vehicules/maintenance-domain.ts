/** Entretien V2 : règles pures, aucune modification implicite du compteur. */
import { createHash } from "node:crypto"
import { z } from "zod"
import { MAX_MILEAGE, MileageDomainError } from "./mileage-domain"

const mileage = z.number().int().min(0).max(MAX_MILEAGE)
const entrySchema = z.object({
  kind: z.enum(["OIL_CHANGE", "SERVICE"]),
  occurredAt: z.string().datetime({ offset: true }).transform(value => new Date(value)),
  mileage,
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict()
const planSchema = z.object({
  intervalKm: z.number().int().min(1).max(MAX_MILEAGE).nullable(),
  intervalMonths: z.number().int().min(1).max(120).nullable(),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
}).strict().refine(value => value.intervalKm !== null || value.intervalMonths !== null)
export type MaintenanceEntryInput = z.infer<typeof entrySchema>
export type MaintenancePlanInput = z.infer<typeof planSchema>
export interface MaintenanceObservation { kind: string; occurredAt: Date; mileage: number; recordedAt?: Date }
export function parseMaintenanceEntry(body: unknown, key: string | null) {
  const parsed = entrySchema.safeParse(body)
  const parsedKey = z.string().trim().uuid().safeParse(key)
  if (!parsedKey.success) throw new MileageDomainError("INVALID_IDEMPOTENCY_KEY", 400)
  if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  return { ...parsed.data, notes: parsed.data.notes || null, idempotencyKey: parsedKey.data.toLowerCase() }
}
export function parseMaintenancePlan(body: unknown) {
  const parsed = planSchema.safeParse(body)
  if (!parsed.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  return parsed.data
}
export function maintenanceHash(input: MaintenanceEntryInput, companyId: string, truckId: string, actorId: string) {
  return createHash("sha256").update(JSON.stringify([
    "maintenance-v2:1", companyId, truckId, actorId, input.kind,
    input.occurredAt.toISOString(), input.mileage, input.notes || null,
  ])).digest("hex")
}
export function validateMaintenanceEntry(input: MaintenanceObservation, history: readonly MaintenanceObservation[], currentMileage: number | null, now: Date) {
  if (!Number.isFinite(input.occurredAt.getTime()) || input.occurredAt > now)
    throw new MileageDomainError("MAINTENANCE_FUTURE_DATE", 422)
  if (currentMileage !== null && input.mileage > currentMileage)
    throw new MileageDomainError("MAINTENANCE_ABOVE_CURRENT_MILEAGE", 409)
  for (const entry of history) {
    if ((entry.occurredAt <= input.occurredAt && entry.mileage > input.mileage)
      || (entry.occurredAt > input.occurredAt && entry.mileage < input.mileage))
      throw new MileageDomainError("MAINTENANCE_MILEAGE_ORDER", 409)
  }
}
/** Calendar months, clamped to month end (31 January + 1 month = 28/29 February). */
export function addMaintenanceMonths(date: Date, months: number) {
  const result = new Date(date)
  const day = result.getUTCDate()
  result.setUTCDate(1)
  result.setUTCMonth(result.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate()
  result.setUTCDate(Math.min(day, lastDay))
  return result
}
export function maintenanceSummary(plan: { intervalKm: number | null; intervalMonths: number | null } | null,
  entries: readonly MaintenanceObservation[], currentMileage: number | null, now: Date) {
  const last = entries.filter(entry => entry.kind === "OIL_CHANGE")
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.mileage - a.mileage || (b.recordedAt?.getTime() ?? 0) - (a.recordedAt?.getTime() ?? 0))[0] ?? null
  const nextMileage = last && plan?.intervalKm ? last.mileage + plan.intervalKm : null
  const nextDate = last && plan?.intervalMonths ? addMaintenanceMonths(last.occurredAt, plan.intervalMonths) : null
  const remainingKm = nextMileage !== null && currentMileage !== null ? nextMileage - currentMileage : null
  const remainingDays = nextDate ? Math.ceil((nextDate.getTime() - now.getTime()) / 86_400_000) : null
  const status = !plan ? "NOT_CONFIGURED" : !last ? "NO_HISTORY"
    : currentMileage !== null && currentMileage < last.mileage ? "INCONSISTENT_MILEAGE"
    : (remainingKm !== null && remainingKm <= 0) || (remainingDays !== null && remainingDays <= 0) ? "DUE"
    : (remainingKm !== null && remainingKm <= 1000)
      || (remainingDays !== null && remainingDays <= 30) ? "SOON"
    : plan.intervalKm !== null && currentMileage === null ? "UNKNOWN_MILEAGE" : "OK"
  return { status, lastOilChange: last ? { occurredAt: last.occurredAt.toISOString(), mileage: last.mileage } : null,
    nextMileage, nextDate: nextDate?.toISOString() ?? null, remainingKm, remainingDays }
}
