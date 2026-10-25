import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import { z } from "zod"
import { MileageDomainError } from "../mileage-domain"
export const expenseEnabled = () => process.env.PLANIFICATOR_VEHICLES_V3_ENABLED === "true"
const decimal = (places: number, digits: number) => z.string().regex(new RegExp(`^(?:0|[1-9][0-9]{0,${digits - 1}})(?:\\.[0-9]{1,${places}})?$`)).refine(v => new Prisma.Decimal(v).gt(0))
const money = decimal(2, 12)
const id = z.string().trim().min(1).max(200)
const fields = z.object({ category: z.enum(["FUEL", "MAINTENANCE", "INSURANCE", "OTHER"]), occurredAt: z.string().datetime({ offset: true }), amount: money, currency: z.string().regex(/^[A-Z]{3}$/), litres: decimal(3, 9).nullable().optional(), mileageObservation: z.number().int().min(0).max(9999999).nullable().optional(), supplier: z.string().trim().max(200).nullable().optional(), reference: z.string().trim().max(200).nullable().optional(), receiptFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(), documentVersionId: id.nullable().optional(), maintenanceEntryId: id.nullable().optional(), notes: z.string().trim().max(4000).nullable().optional() }).strict().refine(v => v.category === "FUEL" || v.litres == null)
const revision = z.number().int().min(1).max(2147483646)
const reason = z.string().trim().min(3).max(2000)
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("CREATE"), data: fields }).strict(),
  z.object({ action: z.literal("CORRECT"), expenseId: id, expectedRevision: revision, reason, data: fields }).strict(),
  z.object({ action: z.enum(["APPROVE", "REJECT", "CANCEL"]), expenseId: id, expectedRevision: revision, reason }).strict(),
  z.object({ action: z.literal("ALLOCATE"), expenseId: id, expectedRevision: revision, reason, allocations: z.array(z.object({ mileageTripId: id.nullable(), amount: money }).strict()).max(100) }).strict(),
  z.object({ action: z.literal("RECONCILE"), expenseId: id, expectedRevision: revision, reason, sourceExpenseReportId: id, confirmedCurrency: z.string().regex(/^[A-Z]{3}$/), confirmedAmount: money }).strict(),
])
export type ExpenseCommand = z.infer<typeof schema>
export function parseExpenseCommand(body: unknown, key: string | null) {
  if (!z.string().uuid().safeParse(key).success) throw new MileageDomainError("INVALID_IDEMPOTENCY_KEY", 400)
  const result = schema.safeParse(body)
  if (!result.success) throw new MileageDomainError("INVALID_PAYLOAD", 400)
  if ((result.data.action === "CREATE" || result.data.action === "CORRECT") && new Date(result.data.data.occurredAt).getTime() > Date.now() + 300000) throw new MileageDomainError("FUTURE_EXPENSE", 400)
  return { command: result.data, key: key!.toLowerCase() }
}
export function expenseHash(command: ExpenseCommand, companyId: string, truckId: string, actorId: string) {
  return createHash("sha256").update(JSON.stringify(["expenses-v3:1", companyId, truckId, actorId, command])).digest("hex")
}
export function assertAllocationTotal(amount: Prisma.Decimal | string, allocations: { amount: Prisma.Decimal | string; mileageTripId: string | null }[]) {
  const ids = allocations.map(a => a.mileageTripId ?? "vehicle")
  if (new Set(ids).size !== ids.length) throw new MileageDomainError("DUPLICATE_ALLOCATION_TARGET", 400)
  const total = allocations.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0))
  if (allocations.some(a => new Prisma.Decimal(a.amount).lte(0)) || total.gt(amount)) throw new MileageDomainError("OVER_ALLOCATION", 409)
  return total
}
export function parseCostPeriod(from: string | null, to: string | null, currency: string | null) {
  const parsed = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }), currency: z.string().regex(/^[A-Z]{3}$/) }).safeParse({ from, to, currency })
  if (!parsed.success) throw new MileageDomainError("INVALID_PERIOD", 400)
  const start = new Date(parsed.data.from), end = new Date(parsed.data.to)
  if (end <= start || end.getTime() - start.getTime() > 366 * 86400000) throw new MileageDomainError("INVALID_PERIOD", 400)
  return { from: start, to: end, currency: parsed.data.currency }
}
