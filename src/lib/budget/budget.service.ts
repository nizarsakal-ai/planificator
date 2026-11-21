/**
 * Lot C Planificator V2 : service des budgets chantier et des imputations de factures fournisseurs. Toute lecture et
 * écriture est bornée par `ctx.companyId` (issu de la session, jamais d'une entrée client). Chaque écriture produit une
 * ligne `HistoryLog` dans la même transaction ; tout échec annule l'ensemble (aucun audit d'une écriture refusée).
 *
 * Historique : une version de budget n'est jamais modifiée ni supprimée (déclencheurs en base). Réviser = AJOUTER la
 * version n+1 avec son motif, puis faire avancer `currentRevision` de n à n+1 sous condition (`updateMany … where
 * currentRevision = n`) après verrouillage de la ligne du budget (`SELECT … FOR UPDATE`). Deux révisions concurrentes
 * partant de la même version : la seconde est refusée (« révisé entre-temps »), jamais fusionnée en silence.
 *
 * Imputation : la ligne de la facture fournisseur est verrouillée, puis le total déjà imputé est relu ; le nouveau
 * total ne peut pas dépasser le montant HT de la facture. Une imputation ne se supprime pas : elle s'annule (une fois).
 */
import { Prisma, type HistoryAction, type PrismaClient } from "@prisma/client"
import { formatEuro } from "@/lib/billing/money"
import {
  BUDGET_ERRORS, COST_NATURE_LABEL, LABEL_MAX, planAllocation, planBudgetVersion, sameVersion, validateReason,
  type BudgetLineInput, type BudgetVersion, type WorksiteCostNature,
} from "@/lib/budget/budget.core"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface BudgetServiceContext { companyId: string; userId: string }
export type BudgetResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

class BudgetFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "BudgetFailure" }
}
const fail = (m: string): never => { throw new BudgetFailure(m) }
function must<T>(p: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!p.ok) fail(p.error)
  return (p as { ok: true; value: T }).value
}
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, uniqueViolation?: string): Promise<BudgetResult<T>> {
  try {
    return { ok: true, value: await db.$transaction(fn) }
  } catch (e) {
    if (e instanceof BudgetFailure) return { ok: false, error: e.userMessage }
    if (uniqueViolation && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: uniqueViolation }
    throw e
  }
}

async function audit(tx: Tx, ctx: BudgetServiceContext, a: { action: HistoryAction; entityType: string; entityId: string; detail: string; worksiteId: string; oldValue?: Prisma.InputJsonValue; newValue?: Prisma.InputJsonValue }) {
  await tx.historyLog.create({
    data: { companyId: ctx.companyId, actorId: ctx.userId, worksiteId: a.worksiteId, action: a.action, entityType: a.entityType, entityId: a.entityId, detail: a.detail, oldValue: a.oldValue, newValue: a.newValue },
  })
}

/** Résumé JSON d'une version (montants en chaînes : BigInt n'est pas sérialisable). */
const versionJson = (number: number, v: BudgetVersion): Prisma.InputJsonValue => ({
  revision: number,
  plannedRevenueCents: v.plannedRevenueCents.toString(),
  totalCostCents: v.totalCostCents.toString(),
  lines: v.lines.map((l) => ({ nature: l.nature, amountCents: l.amountCents.toString(), label: l.label })),
})

async function requireWorksite(tx: Tx, ctx: BudgetServiceContext, worksiteId: string, allowArchived: boolean) {
  const w = (await tx.worksite.findFirst({ where: { id: worksiteId, companyId: ctx.companyId }, select: { id: true, name: true, archivedAt: true } })) ?? fail(BUDGET_ERRORS.notFound)
  if (!allowArchived && w.archivedAt) fail(BUDGET_ERRORS.archived)
  return w
}

/**
 * Version puis lignes, dans la MÊME transaction (la garde en base n'admet une ligne que dans une version créée par la
 * transaction courante). Correctif c1-v6 : pas de création imbriquée — avec `lines: { create }`, Prisma exige l'entrée
 * « checked » (relations) et refuse le scalaire `companyId`, partagé par les clés composites ; on écrit donc la version en
 * scalaires, puis ses lignes par `createMany` avec `companyId` et `revisionId` explicites.
 */
async function insertVersion(tx: Tx, ctx: BudgetServiceContext, budgetId: string, number: number, version: BudgetVersion, reason: string | null) {
  const revision = await tx.worksiteBudgetRevision.create({
    data: {
      companyId: ctx.companyId, budgetId, number, kind: number === 1 ? "INITIAL" : "REVISED", reason,
      plannedRevenueCents: version.plannedRevenueCents, totalCostCents: version.totalCostCents, createdById: ctx.userId,
    },
    select: { id: true },
  })
  if (version.lines.length > 0) {
    await tx.worksiteBudgetLine.createMany({
      data: version.lines.map((l) => ({ companyId: ctx.companyId, revisionId: revision.id, nature: l.nature, amountCents: l.amountCents, label: l.label })),
    })
  }
  return revision
}

/** Avance la version courante de `from` à `from + 1` ; 0 ligne modifiée ⇒ quelqu'un a révisé entre-temps. */
async function advance(tx: Tx, ctx: BudgetServiceContext, budgetId: string, from: number) {
  const r = await tx.worksiteBudget.updateMany({ where: { id: budgetId, companyId: ctx.companyId, currentRevision: from }, data: { currentRevision: from + 1 } })
  if (r.count !== 1) fail(BUDGET_ERRORS.staleRevision)
}

export interface BudgetInput { worksiteId: string; plannedRevenueCents: bigint; lines: readonly BudgetLineInput[] }

/** Budget initial (version 1) d'un chantier actif de l'entreprise ; un seul budget par chantier. */
export async function createBudget(db: Db, ctx: BudgetServiceContext, input: BudgetInput): Promise<BudgetResult<{ budgetId: string }>> {
  const version = planBudgetVersion(input)
  if (!version.ok) return version
  return inTx(db, async (tx) => {
    const w = await requireWorksite(tx, ctx, input.worksiteId, false)
    if (await tx.worksiteBudget.findFirst({ where: { worksiteId: w.id, companyId: ctx.companyId }, select: { id: true } })) fail(BUDGET_ERRORS.alreadyExists)
    const budget = await tx.worksiteBudget.create({ data: { companyId: ctx.companyId, worksiteId: w.id, createdById: ctx.userId }, select: { id: true } })
    await insertVersion(tx, ctx, budget.id, 1, version.value, null)
    await advance(tx, ctx, budget.id, 0)
    await audit(tx, ctx, {
      action: "CREATED", entityType: "WorksiteBudget", entityId: budget.id, worksiteId: w.id, newValue: versionJson(1, version.value),
      detail: `Budget initial du chantier ${w.name} : coûts ${formatEuro(version.value.totalCostCents)}, recette prévue ${formatEuro(version.value.plannedRevenueCents)}`,
    })
    return { budgetId: budget.id }
  }, BUDGET_ERRORS.alreadyExists)
}

export interface RevisionInput extends BudgetInput { expectedRevision: number; reason: string }

/**
 * Révision : ajoute la version `expectedRevision + 1` avec son motif. Refus si la version courante n'est plus celle
 * vue par l'utilisateur (révision concurrente), si rien ne change, ou si le chantier est archivé.
 */
export async function reviseBudget(db: Db, ctx: BudgetServiceContext, input: RevisionInput): Promise<BudgetResult<{ revision: number }>> {
  const version = planBudgetVersion(input)
  if (!version.ok) return version
  const reason = validateReason(input.reason)
  if (!reason.ok) return reason
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) return { ok: false, error: BUDGET_ERRORS.invalidForm }
  return inTx(db, async (tx) => {
    const w = await requireWorksite(tx, ctx, input.worksiteId, false)
    const rows = await tx.$queryRaw<{ id: string; currentRevision: number }[]>`SELECT "id", "currentRevision" FROM "worksite_budgets" WHERE "worksiteId" = ${w.id} AND "companyId" = ${ctx.companyId} FOR UPDATE`
    if (rows.length !== 1) fail(BUDGET_ERRORS.notFound)
    const budget = rows[0]
    if (budget.currentRevision !== input.expectedRevision) fail(BUDGET_ERRORS.staleRevision)
    const current = (await tx.worksiteBudgetRevision.findFirst({
      where: { companyId: ctx.companyId, budgetId: budget.id, number: budget.currentRevision },
      select: { plannedRevenueCents: true, totalCostCents: true, lines: { select: { nature: true, amountCents: true, label: true } } },
    })) ?? fail(BUDGET_ERRORS.notFound)
    const before: BudgetVersion = must(planBudgetVersion({ plannedRevenueCents: current.plannedRevenueCents, lines: current.lines }))
    if (sameVersion(before, version.value)) fail(BUDGET_ERRORS.unchanged)
    const next = budget.currentRevision + 1
    await insertVersion(tx, ctx, budget.id, next, version.value, reason.value)
    await advance(tx, ctx, budget.id, budget.currentRevision)
    await audit(tx, ctx, {
      action: "UPDATED", entityType: "WorksiteBudget", entityId: budget.id, worksiteId: w.id,
      oldValue: versionJson(budget.currentRevision, before), newValue: { ...(versionJson(next, version.value) as Prisma.JsonObject), reason: reason.value },
      detail: `Révision ${next} du budget du chantier ${w.name} (${reason.value}) : coûts ${formatEuro(before.totalCostCents)} → ${formatEuro(version.value.totalCostCents)}, recette ${formatEuro(before.plannedRevenueCents)} → ${formatEuro(version.value.plannedRevenueCents)}`,
    })
    return { revision: next }
  })
}

export interface AllocationInput { supplierInvoiceId: string; worksiteId: string; nature: string; amountHTCents: bigint; label?: string | null }

/**
 * Impute tout ou partie (HT) d'une facture fournisseur à un chantier, pour une nature de coût. Refus si la facture est
 * rattachée à une réception (lot A) ou à une location (lot B) — son coût est déjà compté —, si elle est refusée, ou si
 * le total imputé dépasserait son montant HT. Admis sur un chantier archivé (facture tardive), jamais sur un chantier
 * d'une autre entreprise.
 */
export async function allocateSupplierInvoice(db: Db, ctx: BudgetServiceContext, input: AllocationInput): Promise<BudgetResult<{ id: string }>> {
  return inTx(db, async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "supplier_invoices" WHERE "id" = ${input.supplierInvoiceId} AND "companyId" = ${ctx.companyId} FOR UPDATE`
    if (locked.length !== 1) fail(BUDGET_ERRORS.notFound)
    const inv = (await tx.supplierInvoice.findFirst({
      where: { id: input.supplierInvoiceId, companyId: ctx.companyId },
      select: { id: true, number: true, supplierName: true, status: true, totalHTCents: true, _count: { select: { goodsReceipts: true, equipmentRentals: true } } },
    })) ?? fail(BUDGET_ERRORS.notFound)
    const w = await requireWorksite(tx, ctx, input.worksiteId, true)
    const already = await tx.supplierInvoiceAllocation.aggregate({ where: { companyId: ctx.companyId, supplierInvoiceId: inv.id, cancelledAt: null }, _sum: { amountHTCents: true } })
    const plan = must(planAllocation({
      nature: input.nature, amountHTCents: input.amountHTCents, invoiceTotalHTCents: inv.totalHTCents,
      alreadyAllocatedCents: already._sum.amountHTCents ?? BigInt(0), invoiceStatus: inv.status,
      linkedElsewhere: inv._count.goodsReceipts > 0 || inv._count.equipmentRentals > 0,
    }))
    const trimmed = (input.label ?? "").trim()
    if (trimmed.length > LABEL_MAX) fail(BUDGET_ERRORS.label)
    const label = trimmed || null
    const a = await tx.supplierInvoiceAllocation.create({
      data: { companyId: ctx.companyId, supplierInvoiceId: inv.id, worksiteId: w.id, nature: plan.nature as WorksiteCostNature, amountHTCents: input.amountHTCents, label, createdById: ctx.userId },
      select: { id: true },
    })
    await audit(tx, ctx, {
      action: "CREATED", entityType: "SupplierInvoiceAllocation", entityId: a.id, worksiteId: w.id,
      detail: `Facture fournisseur ${inv.number} (${inv.supplierName}) : ${formatEuro(input.amountHTCents)} HT imputés au chantier ${w.name} (${COST_NATURE_LABEL[plan.nature]})`,
    })
    return { id: a.id }
  })
}

/** Annule une imputation (une seule fois) d'un chantier donné ; la ligne reste dans l'historique. */
export async function cancelAllocation(db: Db, ctx: BudgetServiceContext, allocationId: string, worksiteId: string): Promise<BudgetResult<{ worksiteId: string }>> {
  return inTx(db, async (tx) => {
    const a = (await tx.supplierInvoiceAllocation.findFirst({
      where: { id: allocationId, companyId: ctx.companyId, worksiteId },
      select: { id: true, worksiteId: true, cancelledAt: true, amountHTCents: true, supplierInvoice: { select: { number: true } }, worksite: { select: { name: true } } },
    })) ?? fail(BUDGET_ERRORS.notFound)
    if (a.cancelledAt) fail(BUDGET_ERRORS.allocationCancelled)
    const r = await tx.supplierInvoiceAllocation.updateMany({ where: { id: a.id, companyId: ctx.companyId, cancelledAt: null }, data: { cancelledAt: new Date(), cancelledById: ctx.userId } })
    if (r.count !== 1) fail(BUDGET_ERRORS.allocationCancelled)
    await audit(tx, ctx, {
      action: "STATUS_CHANGED", entityType: "SupplierInvoiceAllocation", entityId: a.id, worksiteId: a.worksiteId,
      detail: `Imputation annulée : facture fournisseur ${a.supplierInvoice.number}, ${formatEuro(a.amountHTCents)} HT, chantier ${a.worksite.name}`,
    })
    return { worksiteId: a.worksiteId }
  })
}
