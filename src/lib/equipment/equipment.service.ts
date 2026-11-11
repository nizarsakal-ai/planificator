/**
 * Lot B Planificator V2 : service du matériel et de la location. Toute lecture et écriture est bornée par
 * `ctx.companyId` (issu de la session, jamais d'une entrée client). Chaque écriture métier produit une ligne
 * `HistoryLog` dans la même transaction. Les règles viennent de `equipment.core.ts` ; la base porte les mêmes
 * invariants (CHECK, clés composites).
 *
 * Concurrence (pas de double réservation) : toute opération qui dépend des réservations ou des contrats d'un
 * équipement commence par VERROUILLER sa ligne (`SELECT … FOR UPDATE`, bornée par companyId), puis relit réservations
 * et contrats et contrôle le chevauchement dans la même transaction. Deux réservations concurrentes du même
 * équipement sont donc sérialisées : la seconde voit la première et est refusée. Les transitions d'état écrivent sous
 * condition de l'état lu (`updateMany … where status = lu`) ; sinon CONFLIT et ROLLBACK.
 */
import type { HistoryAction, Prisma, PrismaClient } from "@prisma/client"
import { businessYear } from "@/lib/billing/business-day"
import { serverNow } from "@/lib/billing/clock"
import {
  EQUIPMENT_ERRORS, dayPeriod, formatDay, planBooking, planCheckout, planRentalCancel, planRentalClose,
  planRentalContract, planReturn, planStatusChange, validCents, validateEquipmentIdentity, validateMaintenance,
  type BookingStatus, type EquipmentOwnership, type EquipmentStatus,
} from "@/lib/equipment/equipment.core"
import { formatEuro } from "@/lib/billing/money"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface EquipmentServiceContext { companyId: string; userId: string }
export type EquipmentResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

class EquipmentFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "EquipmentFailure" }
}
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<EquipmentResult<T>> {
  try {
    return { ok: true, value: await db.$transaction(fn) }
  } catch (e) {
    if (e instanceof EquipmentFailure) return { ok: false, error: e.userMessage }
    // Correctif 06/11/2026 (échec VM v6, concurrence) : la garde en base (déclencheur equipment_bookings_no_overlap) refuse un
    // chevauchement que la vérification applicative n'a pas vu ; la transaction est annulée, le refus est rendu tel quel.
    if (e instanceof Error && /\bEQUIPMENT_BOOKING_OVERLAP\b/.test(e.message)) return { ok: false, error: EQUIPMENT_ERRORS.overlap }
    throw e
  }
}
const fail = (m: string): never => { throw new EquipmentFailure(m) }
function must<T>(p: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!p.ok) fail(p.error)
  return (p as { ok: true; value: T }).value
}

async function audit(tx: Tx, ctx: EquipmentServiceContext, a: { action: HistoryAction; entityType: string; entityId: string; detail: string; worksiteId?: string | null }) {
  await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, worksiteId: a.worksiteId ?? null, action: a.action, entityType: a.entityType, entityId: a.entityId, detail: a.detail } })
}

async function nextRentalNumber(tx: Tx, companyId: string): Promise<string> {
  const year = businessYear(serverNow())
  const c = await tx.documentCounter.upsert({
    where: { companyId_type_year: { companyId, type: "EQUIPMENT_RENTAL", year } },
    create: { companyId, type: "EQUIPMENT_RENTAL", year, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
  })
  return `LOC-${year}-${String(c.lastValue).padStart(4, "0")}`
}

/** Verrouille la ligne de l'équipement (même entreprise) jusqu'à la fin de la transaction, puis la relit. */
async function lockEquipment(tx: Tx, ctx: EquipmentServiceContext, equipmentId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "equipment" WHERE "id" = ${equipmentId} AND "companyId" = ${ctx.companyId} FOR UPDATE`
  if (rows.length !== 1) fail(EQUIPMENT_ERRORS.notFound)
  return (await tx.equipment.findFirst({
    where: { id: equipmentId, companyId: ctx.companyId },
    select: { id: true, number: true, name: true, status: true, ownership: true, warehouseId: true },
  })) ?? fail(EQUIPMENT_ERRORS.notFound)
}
const activeBookings = (tx: Tx, ctx: EquipmentServiceContext, equipmentId: string) =>
  tx.equipmentBooking.findMany({ where: { companyId: ctx.companyId, equipmentId, status: { in: ["RESERVED", "CHECKED_OUT"] } }, select: { id: true, status: true, startAt: true, endAt: true, checkedOutAt: true } }) // B-R1 : sortie anticipée
const contractsOf = (tx: Tx, ctx: EquipmentServiceContext, equipmentId: string) =>
  tx.equipmentRentalContract.findMany({ where: { companyId: ctx.companyId, equipmentId }, select: { id: true, status: true, startDate: true, endDate: true, dailyRateCents: true, fixedFeesCents: true } })

async function requireWarehouse(tx: Tx, ctx: EquipmentServiceContext, warehouseId: string) {
  const w = (await tx.warehouse.findFirst({ where: { id: warehouseId, companyId: ctx.companyId }, select: { id: true, name: true, active: true } })) ?? fail(EQUIPMENT_ERRORS.notFound)
  if (!w.active) fail("Ce dépôt est désactivé.")
  return w
}
/** Chantier de l'entreprise, non archivé (nouvelle imputation). */
async function requireWorksite(tx: Tx, ctx: EquipmentServiceContext, worksiteId: string) {
  return (await tx.worksite.findFirst({ where: { id: worksiteId, companyId: ctx.companyId, archivedAt: null }, select: { id: true, name: true } })) ?? fail(EQUIPMENT_ERRORS.notFound)
}
async function requireEmployee(tx: Tx, ctx: EquipmentServiceContext, employeeId: string) {
  return (await tx.employee.findFirst({ where: { id: employeeId, companyId: ctx.companyId, active: true }, select: { id: true, firstName: true, lastName: true } })) ?? fail(EQUIPMENT_ERRORS.notFound)
}
async function requireSupplier(tx: Tx, ctx: EquipmentServiceContext, supplierId: string) {
  return (await tx.supplier.findFirst({ where: { id: supplierId, companyId: ctx.companyId, active: true }, select: { id: true, name: true } })) ?? fail(EQUIPMENT_ERRORS.notFound)
}

// ─────────────────────────────── Équipements ───────────────────────────────

export async function createEquipment(db: Db, ctx: EquipmentServiceContext, input: {
  number: string; name: string; category: string; serialNumber?: string | null; ownership: EquipmentOwnership
  warehouseId?: string | null; dailyCostCents?: number | null; notes?: string | null
}): Promise<EquipmentResult<{ id: string }>> {
  const id = validateEquipmentIdentity(input)
  if (!id.ok) return id
  const serialNumber = input.serialNumber?.trim() || null
  const notes = input.notes?.trim() || null
  if ((serialNumber && serialNumber.length > 120) || (notes && notes.length > 2000)) return { ok: false, error: "Numéro de série ou notes trop longs." }
  if (input.ownership !== "OWNED" && input.ownership !== "RENTED") return { ok: false, error: "Propriété invalide." }
  if (!validCents(input.dailyCostCents)) return { ok: false, error: EQUIPMENT_ERRORS.invalidAmount }
  return inTx(db, async (tx) => {
    if (await tx.equipment.findFirst({ where: { companyId: ctx.companyId, number: id.value.number }, select: { id: true } })) fail(EQUIPMENT_ERRORS.duplicateNumber)
    const warehouse = input.warehouseId ? await requireWarehouse(tx, ctx, input.warehouseId) : null
    const e = await tx.equipment.create({
      data: { companyId: ctx.companyId, ...id.value, serialNumber, ownership: input.ownership, warehouseId: warehouse?.id ?? null, dailyCostCents: input.dailyCostCents ?? null, notes },
      select: { id: true },
    })
    await audit(tx, ctx, { action: "CREATED", entityType: "Equipment", entityId: e.id, detail: `Équipement ${id.value.number} « ${id.value.name} » créé (${input.ownership === "RENTED" ? "loué" : "propriété"})${warehouse ? `, dépôt ${warehouse.name}` : ""}` })
    return e
  })
}

/** Modification de la fiche (le numéro et la propriété sont figés à la création). */
export async function updateEquipment(db: Db, ctx: EquipmentServiceContext, equipmentId: string, input: {
  name: string; category: string; serialNumber?: string | null; warehouseId?: string | null; dailyCostCents?: number | null; notes?: string | null
}): Promise<EquipmentResult> {
  const name = input.name.trim()
  const category = input.category.trim()
  if (!name || name.length > 160 || !category || category.length > 80) return { ok: false, error: EQUIPMENT_ERRORS.invalidName }
  const serialNumber = input.serialNumber?.trim() || null
  const notes = input.notes?.trim() || null
  if ((serialNumber && serialNumber.length > 120) || (notes && notes.length > 2000)) return { ok: false, error: "Numéro de série ou notes trop longs." }
  if (!validCents(input.dailyCostCents)) return { ok: false, error: EQUIPMENT_ERRORS.invalidAmount }
  return inTx(db, async (tx) => {
    const e = await lockEquipment(tx, ctx, equipmentId)
    const warehouse = input.warehouseId ? await requireWarehouse(tx, ctx, input.warehouseId) : null
    const r = await tx.equipment.updateMany({
      where: { id: e.id, companyId: ctx.companyId },
      data: { name, category, serialNumber, warehouseId: warehouse?.id ?? null, dailyCostCents: input.dailyCostCents ?? null, notes },
    })
    if (r.count !== 1) fail(EQUIPMENT_ERRORS.conflict)
    await audit(tx, ctx, { action: "UPDATED", entityType: "Equipment", entityId: e.id, detail: `Fiche de ${e.number} modifiée${warehouse ? `, dépôt ${warehouse.name}` : ", sans dépôt"}` })
    return undefined
  })
}

/** Changement d'état manuel (entretien, remise en service, réforme). Refusé si une sortie est en cours. */
export async function setEquipmentStatus(db: Db, ctx: EquipmentServiceContext, equipmentId: string, to: string): Promise<EquipmentResult> {
  return inTx(db, async (tx) => {
    const e = await lockEquipment(tx, ctx, equipmentId)
    const next = must(planStatusChange(e.status, to))
    if (next === "RETIRED" && (await activeBookings(tx, ctx, e.id)).length > 0) fail("Des réservations sont en cours : annulez-les avant de réformer l'équipement.")
    const r = await tx.equipment.updateMany({ where: { id: e.id, companyId: ctx.companyId, status: e.status }, data: { status: next } })
    if (r.count !== 1) fail(EQUIPMENT_ERRORS.conflict)
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "Equipment", entityId: e.id, detail: `Équipement ${e.number} : ${e.status} → ${next}` })
    return undefined
  })
}

// ─────────────────────────────── Réservations ───────────────────────────────

export async function createBooking(db: Db, ctx: EquipmentServiceContext, input: {
  equipmentId: string; firstDay: Date; lastDay: Date; worksiteId?: string | null; responsibleEmployeeId?: string | null; depositCents?: number | null
}, now: Date = serverNow()): Promise<EquipmentResult<{ id: string }>> {
  const period = dayPeriod(input.firstDay, input.lastDay)
  if (!period.ok) return period
  return inTx(db, async (tx) => {
    const e = await lockEquipment(tx, ctx, input.equipmentId)
    const [bookings, contracts] = await Promise.all([activeBookings(tx, ctx, e.id), contractsOf(tx, ctx, e.id)])
    must(planBooking({ equipmentStatus: e.status, ownership: e.ownership, wanted: period.value, bookings, contracts, now, depositCents: input.depositCents }))
    const worksite = input.worksiteId ? await requireWorksite(tx, ctx, input.worksiteId) : null
    const responsible = input.responsibleEmployeeId ? await requireEmployee(tx, ctx, input.responsibleEmployeeId) : null
    const b = await tx.equipmentBooking.create({
      data: {
        companyId: ctx.companyId, equipmentId: e.id, worksiteId: worksite?.id ?? null, responsibleEmployeeId: responsible?.id ?? null,
        startAt: period.value.startAt, endAt: period.value.endAt, depositCents: input.depositCents ?? null, createdById: ctx.userId,
      },
      select: { id: true },
    })
    await audit(tx, ctx, { action: "CREATED", entityType: "EquipmentBooking", entityId: b.id, worksiteId: worksite?.id, detail: `Réservation de ${e.number} du ${formatDay(input.firstDay)} au ${formatDay(input.lastDay)}${worksite ? ` pour le chantier « ${worksite.name} »` : ""}${responsible ? `, responsable ${responsible.firstName} ${responsible.lastName}` : ""}` })
    return b
  })
}

async function lockedBooking(tx: Tx, ctx: EquipmentServiceContext, bookingId: string) {
  const head = (await tx.equipmentBooking.findFirst({ where: { id: bookingId, companyId: ctx.companyId }, select: { equipmentId: true } })) ?? fail(EQUIPMENT_ERRORS.notFound)
  const equipment = await lockEquipment(tx, ctx, head.equipmentId)
  const booking = (await tx.equipmentBooking.findFirst({ where: { id: bookingId, companyId: ctx.companyId }, select: { id: true, status: true, startAt: true, endAt: true, worksiteId: true, checkedOutAt: true } })) ?? fail(EQUIPMENT_ERRORS.notFound)
  return { equipment, booking }
}
async function transition(tx: Tx, ctx: EquipmentServiceContext, bookingId: string, from: BookingStatus, data: Prisma.EquipmentBookingUpdateManyMutationInput) {
  const r = await tx.equipmentBooking.updateMany({ where: { id: bookingId, companyId: ctx.companyId, status: from }, data })
  if (r.count !== 1) fail(EQUIPMENT_ERRORS.conflict)
}
async function setStatus(tx: Tx, ctx: EquipmentServiceContext, equipmentId: string, from: EquipmentStatus, data: Prisma.EquipmentUncheckedUpdateManyInput) {
  const r = await tx.equipment.updateMany({ where: { id: equipmentId, companyId: ctx.companyId, status: from }, data })
  if (r.count !== 1) fail(EQUIPMENT_ERRORS.conflict)
}

/** Sortie : état constaté au départ ; l'équipement passe « sorti ». */
export async function checkoutBooking(db: Db, ctx: EquipmentServiceContext, bookingId: string, condition: string, now: Date = serverNow()): Promise<EquipmentResult> {
  return inTx(db, async (tx) => {
    const { equipment, booking } = await lockedBooking(tx, ctx, bookingId)
    const c = must(planCheckout({ booking, equipmentStatus: equipment.status, condition, others: await activeBookings(tx, ctx, equipment.id), now }))
    await transition(tx, ctx, booking.id, "RESERVED", { status: "CHECKED_OUT", checkedOutAt: now, checkoutCondition: c })
    await setStatus(tx, ctx, equipment.id, "AVAILABLE", { status: "OUT", condition: c })
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "EquipmentBooking", entityId: booking.id, worksiteId: booking.worksiteId, detail: `Sortie de ${equipment.number}, état ${c}` })
    return undefined
  })
}

/** Retour : état constaté ; endommagé ⇒ entretien, sinon disponible ; dépôt de retour facultatif. */
export async function returnBooking(db: Db, ctx: EquipmentServiceContext, bookingId: string, input: { condition: string; notes?: string | null; warehouseId?: string | null }, now: Date = serverNow()): Promise<EquipmentResult<{ nextStatus: EquipmentStatus }>> {
  const notes = input.notes?.trim() || null
  if (notes && notes.length > 1000) return { ok: false, error: "Observations trop longues." }
  return inTx(db, async (tx) => {
    const { equipment, booking } = await lockedBooking(tx, ctx, bookingId)
    const r = must(planReturn(booking.status, input.condition))
    if (equipment.status !== "OUT") fail(EQUIPMENT_ERRORS.conflict)
    const warehouse = input.warehouseId ? await requireWarehouse(tx, ctx, input.warehouseId) : null
    const returnedAt = booking.checkedOutAt && now.getTime() < booking.checkedOutAt.getTime() ? booking.checkedOutAt : now
    await transition(tx, ctx, booking.id, "CHECKED_OUT", { status: "RETURNED", returnedAt, returnCondition: r.condition, returnNotes: notes })
    await setStatus(tx, ctx, equipment.id, "OUT", { status: r.nextStatus, condition: r.condition, ...(warehouse ? { warehouseId: warehouse.id } : {}) })
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "EquipmentBooking", entityId: booking.id, worksiteId: booking.worksiteId, detail: `Retour de ${equipment.number}, état ${r.condition}${r.nextStatus === "MAINTENANCE" ? " : passage en entretien" : ""}${warehouse ? `, dépôt ${warehouse.name}` : ""}` })
    return { nextStatus: r.nextStatus }
  })
}

export async function cancelBooking(db: Db, ctx: EquipmentServiceContext, bookingId: string): Promise<EquipmentResult> {
  return inTx(db, async (tx) => {
    const { equipment, booking } = await lockedBooking(tx, ctx, bookingId)
    if (booking.status !== "RESERVED") fail(EQUIPMENT_ERRORS.notReserved)
    await transition(tx, ctx, booking.id, "RESERVED", { status: "CANCELLED" })
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "EquipmentBooking", entityId: booking.id, worksiteId: booking.worksiteId, detail: `Réservation de ${equipment.number} annulée` })
    return undefined
  })
}

// ─────────────────────────────── Contrats de location ───────────────────────────────

export async function createRentalContract(db: Db, ctx: EquipmentServiceContext, input: {
  equipmentId: string; supplierId: string; worksiteId?: string | null; startDate: Date; endDate: Date
  dailyRateCents: number; fixedFeesCents?: number; notes?: string | null
}): Promise<EquipmentResult<{ id: string; number: string }>> {
  const notes = input.notes?.trim() || null
  if (notes && notes.length > 2000) return { ok: false, error: "Notes trop longues." }
  const fixedFeesCents = input.fixedFeesCents ?? 0
  return inTx(db, async (tx) => {
    const e = await lockEquipment(tx, ctx, input.equipmentId)
    must(planRentalContract({ ownership: e.ownership, equipmentStatus: e.status, startDate: input.startDate, endDate: input.endDate, dailyRateCents: input.dailyRateCents, fixedFeesCents, contracts: await contractsOf(tx, ctx, e.id) }))
    const supplier = await requireSupplier(tx, ctx, input.supplierId)
    const worksite = input.worksiteId ? await requireWorksite(tx, ctx, input.worksiteId) : null
    const number = await nextRentalNumber(tx, ctx.companyId)
    const c = await tx.equipmentRentalContract.create({
      data: { companyId: ctx.companyId, number, equipmentId: e.id, supplierId: supplier.id, worksiteId: worksite?.id ?? null, startDate: input.startDate, endDate: input.endDate, dailyRateCents: input.dailyRateCents, fixedFeesCents, notes, createdById: ctx.userId },
      select: { id: true },
    })
    await audit(tx, ctx, { action: "CREATED", entityType: "EquipmentRentalContract", entityId: c.id, worksiteId: worksite?.id, detail: `Contrat ${number} : ${e.number} loué chez ${supplier.name} du ${formatDay(input.startDate)} au ${formatDay(input.endDate)}, ${formatEuro(BigInt(input.dailyRateCents))}/jour${fixedFeesCents ? ` + ${formatEuro(BigInt(fixedFeesCents))} de frais` : ""}${worksite ? `, imputé au chantier « ${worksite.name} »` : ""}` })
    return { id: c.id, number }
  })
}

async function lockedContract(tx: Tx, ctx: EquipmentServiceContext, contractId: string) {
  const head = (await tx.equipmentRentalContract.findFirst({ where: { id: contractId, companyId: ctx.companyId }, select: { equipmentId: true } })) ?? fail(EQUIPMENT_ERRORS.notFound)
  const equipment = await lockEquipment(tx, ctx, head.equipmentId)
  const contract = (await tx.equipmentRentalContract.findFirst({ where: { id: contractId, companyId: ctx.companyId }, select: { id: true, number: true, status: true, startDate: true, endDate: true, dailyRateCents: true, fixedFeesCents: true, worksiteId: true, supplierId: true } })) ?? fail(EQUIPMENT_ERRORS.notFound)
  return { equipment, contract }
}

/** Clôture au retour chez le loueur : coût figé (jours facturés × tarif + frais), imputé au chantier du contrat. */
export async function closeRentalContract(db: Db, ctx: EquipmentServiceContext, contractId: string, returnedOn: Date, now: Date = serverNow()): Promise<EquipmentResult<{ costCents: bigint }>> {
  return inTx(db, async (tx) => {
    const { equipment, contract } = await lockedContract(tx, ctx, contractId)
    const cost = must(planRentalClose({ contract, returnedOn, bookings: await activeBookings(tx, ctx, equipment.id), now }))
    const r = await tx.equipmentRentalContract.updateMany({ where: { id: contract.id, companyId: ctx.companyId, status: "ACTIVE" }, data: { status: "CLOSED", returnedOn, costCents: cost } })
    if (r.count !== 1) fail(EQUIPMENT_ERRORS.conflict)
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "EquipmentRentalContract", entityId: contract.id, worksiteId: contract.worksiteId, detail: `Contrat ${contract.number} clôturé (retour le ${formatDay(returnedOn)}), coût ${formatEuro(cost)}${contract.worksiteId ? " imputé au chantier" : " sans chantier"}` })
    return { costCents: cost }
  })
}

export async function cancelRentalContract(db: Db, ctx: EquipmentServiceContext, contractId: string, now: Date = serverNow()): Promise<EquipmentResult> {
  return inTx(db, async (tx) => {
    const { equipment, contract } = await lockedContract(tx, ctx, contractId)
    must(planRentalCancel(contract, await activeBookings(tx, ctx, equipment.id), now))
    const r = await tx.equipmentRentalContract.updateMany({ where: { id: contract.id, companyId: ctx.companyId, status: "ACTIVE" }, data: { status: "CANCELLED" } })
    if (r.count !== 1) fail(EQUIPMENT_ERRORS.conflict)
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "EquipmentRentalContract", entityId: contract.id, worksiteId: contract.worksiteId, detail: `Contrat ${contract.number} annulé` })
    return undefined
  })
}

/**
 * Lie (ou délie, null) la facture du loueur à un contrat. La facture doit venir du même fournisseur.
 * B-R2 (revue B v2) : même verrou d'équipement que l'annulation et la clôture, puis relecture du contrat (lockedContract) ;
 * écriture CONDITIONNÉE au statut ACTIVE ou CLOSED et nombre de lignes vérifié AVANT l'audit : une annulation validée entre
 * la lecture et l'écriture fait échouer le rapprochement (ROLLBACK, aucune écriture ni audit).
 */
export async function linkRentalInvoice(db: Db, ctx: EquipmentServiceContext, contractId: string, supplierInvoiceId: string | null): Promise<EquipmentResult> {
  return inTx(db, async (tx) => {
    const { contract } = await lockedContract(tx, ctx, contractId)
    if (contract.status === "CANCELLED") fail(EQUIPMENT_ERRORS.contractCancelled)
    let label = ""
    if (supplierInvoiceId) {
      const inv = (await tx.supplierInvoice.findFirst({ where: { id: supplierInvoiceId, companyId: ctx.companyId }, select: { id: true, supplierId: true, number: true } })) ?? fail(EQUIPMENT_ERRORS.notFound)
      if (inv.supplierId !== contract.supplierId) fail(EQUIPMENT_ERRORS.supplierInvoiceMismatch)
      label = inv.number
    }
    const r = await tx.equipmentRentalContract.updateMany({ where: { id: contract.id, companyId: ctx.companyId, status: { in: ["ACTIVE", "CLOSED"] } }, data: { supplierInvoiceId: supplierInvoiceId ?? null } })
    if (r.count !== 1) fail(EQUIPMENT_ERRORS.conflict)
    await audit(tx, ctx, { action: "UPDATED", entityType: "EquipmentRentalContract", entityId: contract.id, detail: supplierInvoiceId ? `Contrat ${contract.number} lié à la facture fournisseur ${label}` : `Facture fournisseur déliée du contrat ${contract.number}` })
    return undefined
  })
}

// ─────────────────────────────── Entretien ───────────────────────────────

export async function recordMaintenance(db: Db, ctx: EquipmentServiceContext, input: {
  equipmentId: string; description: string; plannedOn?: Date | null; performedOn?: Date | null; costCents?: number | null; supplierId?: string | null
}): Promise<EquipmentResult<{ id: string }>> {
  const plannedOn = input.plannedOn ?? null
  const performedOn = input.performedOn ?? null
  const v = validateMaintenance({ description: input.description, plannedOn, performedOn, costCents: input.costCents ?? null })
  if (!v.ok) return v
  return inTx(db, async (tx) => {
    const e = (await tx.equipment.findFirst({ where: { id: input.equipmentId, companyId: ctx.companyId }, select: { id: true, number: true } })) ?? fail(EQUIPMENT_ERRORS.notFound)
    const supplier = input.supplierId ? await requireSupplier(tx, ctx, input.supplierId) : null
    const m = await tx.equipmentMaintenance.create({
      data: { companyId: ctx.companyId, equipmentId: e.id, description: v.value.description, plannedOn, performedOn, costCents: input.costCents ?? null, supplierId: supplier?.id ?? null, createdById: ctx.userId },
      select: { id: true },
    })
    await audit(tx, ctx, { action: "CREATED", entityType: "EquipmentMaintenance", entityId: m.id, detail: `Entretien de ${e.number} ${performedOn ? `réalisé le ${formatDay(performedOn)}` : `prévu le ${formatDay(plannedOn!)}`} : ${v.value.description}` })
    return m
  })
}

/** Marque réalisé un entretien prévu (date et coût réels). */
export async function completeMaintenance(db: Db, ctx: EquipmentServiceContext, maintenanceId: string, input: { performedOn: Date; costCents?: number | null }): Promise<EquipmentResult> {
  if (!validCents(input.costCents)) return { ok: false, error: EQUIPMENT_ERRORS.invalidAmount }
  return inTx(db, async (tx) => {
    const m = (await tx.equipmentMaintenance.findFirst({ where: { id: maintenanceId, companyId: ctx.companyId }, select: { id: true, performedOn: true, equipment: { select: { number: true } } } })) ?? fail(EQUIPMENT_ERRORS.notFound)
    if (m.performedOn) fail("Cet entretien est déjà réalisé.")
    const r = await tx.equipmentMaintenance.updateMany({ where: { id: m.id, companyId: ctx.companyId, performedOn: null }, data: { performedOn: input.performedOn, ...(input.costCents !== undefined && input.costCents !== null ? { costCents: input.costCents } : {}) } })
    if (r.count !== 1) fail(EQUIPMENT_ERRORS.conflict)
    await audit(tx, ctx, { action: "UPDATED", entityType: "EquipmentMaintenance", entityId: m.id, detail: `Entretien de ${m.equipment.number} réalisé le ${formatDay(input.performedOn)}` })
    return undefined
  })
}
