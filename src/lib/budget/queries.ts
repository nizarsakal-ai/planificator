/**
 * Lot C Planificator V2 : lectures des budgets et marges. Toutes les requêtes sont bornées par `companyId` (session) ;
 * les faits de plusieurs chantiers sont chargés en une seule transaction en lecture répétable (instantané cohérent),
 * par lots bornés, puis confiés à `computeWorksiteMargin` (règles pures, voir budget.core.ts).
 */
import { Prisma, type PrismaClient, type VehicleExpense } from "@prisma/client"
import { decimalToCents } from "@/lib/billing/money"
import { computeWorksiteMargin, type PricePoint, type WorksiteFacts, type WorksiteMargin } from "@/lib/budget/budget.core"
import { expenseSourceStates } from "@/lib/vehicules/v3/expense-service"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export const MAX_WORKSITES = 500
const CHUNK = 200
const READ = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 20000 } as const

function chunks<T>(xs: readonly T[], n = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}
async function inChunks<T, R>(xs: readonly T[], fn: (part: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = []
  for (const part of chunks(xs)) out.push(...(await fn(part)))
  return out
}
type MutableFacts = { -readonly [K in keyof WorksiteFacts]: WorksiteFacts[K] extends readonly (infer U)[] ? U[] : WorksiteFacts[K] }
const emptyFacts = (): MutableFacts => ({
  budget: null, quotes: [], invoices: [], stockIssues: [], otherLinkedMovements: 0, pricePoints: [], orderLines: [],
  rentals: [], ownedBookings: [], ownedBookingsWithoutCost: 0, vehicleAllocations: [], supplierAllocations: [],
})

/** Charge les faits des chantiers donnés (déjà vérifiés comme appartenant à `companyId`). */
export async function loadFacts(tx: Tx, companyId: string, worksiteIds: readonly string[]): Promise<Map<string, WorksiteFacts>> {
  const facts = new Map<string, MutableFacts>()
  for (const id of worksiteIds) facts.set(id, emptyFacts())
  const of = (id: string | null) => (id ? facts.get(id) : undefined)
  const ids = [...worksiteIds]

  const budgets = await inChunks(ids, (part) => tx.worksiteBudget.findMany({ where: { companyId, worksiteId: { in: part } }, select: { worksiteId: true, currentRevision: true, id: true } }))
  // Version courante de chaque budget : une requête par lot (couples budget × numéro), jamais une par chantier.
  const siteOfBudget = new Map(budgets.map((b) => [b.id, b.worksiteId]))
  const currents = await inChunks(budgets, (part) => tx.worksiteBudgetRevision.findMany({
    where: { companyId, OR: part.map((b) => ({ budgetId: b.id, number: b.currentRevision })) },
    select: { budgetId: true, number: true, plannedRevenueCents: true, lines: { select: { nature: true, amountCents: true } } },
  }))
  for (const rev of currents) {
    const f = of(siteOfBudget.get(rev.budgetId) ?? null)
    if (f) f.budget = { revision: rev.number, plannedRevenueCents: rev.plannedRevenueCents, lines: rev.lines }
  }

  for (const q of await inChunks(ids, (part) => tx.quote.findMany({ where: { companyId, worksiteId: { in: part } }, select: { worksiteId: true, status: true, totalHT: true } }))) {
    of(q.worksiteId)?.quotes.push({ status: q.status, totalHTCents: decimalToCents(q.totalHT) })
  }
  for (const i of await inChunks(ids, (part) => tx.invoice.findMany({ where: { companyId, worksiteId: { in: part } }, select: { worksiteId: true, kind: true, sentAt: true, totalHT: true } }))) {
    // Émise = date d'émission posée (une facture abandonnée à l'état de brouillon n'en a pas ; un avoir émis en a une).
    of(i.worksiteId)?.invoices.push({ kind: i.kind, issued: i.sentAt !== null, totalHTCents: decimalToCents(i.totalHT) })
  }

  // Stock : sorties comptées ; réceptions de commande ignorées ici (comptées par les lignes de commande) ; autres signalés.
  const movements = await inChunks(ids, (part) => tx.stockMovement.findMany({ where: { companyId, worksiteId: { in: part } }, select: { worksiteId: true, type: true, articleId: true, quantityMilli: true, createdAt: true, goodsReceiptLineId: true } }))
  const issuedArticles = new Set<string>()
  for (const m of movements) {
    const f = of(m.worksiteId)
    if (!f) continue
    if (m.type === "ISSUE") { f.stockIssues.push({ articleId: m.articleId, quantityMilli: m.quantityMilli, at: m.createdAt }); issuedArticles.add(m.articleId) }
    else if (!(m.type === "RECEIPT" && m.goodsReceiptLineId)) f.otherLinkedMovements++
  }
  const pricePoints: PricePoint[] = (await inChunks([...issuedArticles], (part) => tx.stockMovement.findMany({
    where: { companyId, type: "RECEIPT", goodsReceiptLineId: { not: null }, articleId: { in: part } },
    select: { id: true, articleId: true, createdAt: true, goodsReceiptLine: { select: { orderLine: { select: { unitPriceCents: true } } } } },
  }))).flatMap((m) => (m.goodsReceiptLine ? [{ id: m.id, articleId: m.articleId, at: m.createdAt, unitPriceCents: m.goodsReceiptLine.orderLine.unitPriceCents }] : []))
  for (const f of facts.values()) if (f.stockIssues.length > 0) f.pricePoints = pricePoints

  for (const l of await inChunks(ids, (part) => tx.purchaseOrderLine.findMany({
    where: { purchaseOrder: { companyId, worksiteId: { in: part } } },
    select: { articleId: true, quantityMilli: true, receivedMilli: true, unitPriceCents: true, purchaseOrder: { select: { worksiteId: true, status: true } } },
  }))) {
    of(l.purchaseOrder.worksiteId)?.orderLines.push({ orderStatus: l.purchaseOrder.status, hasArticle: l.articleId !== null, quantityMilli: l.quantityMilli, receivedMilli: l.receivedMilli, unitPriceCents: l.unitPriceCents })
  }

  for (const r of await inChunks(ids, (part) => tx.equipmentRentalContract.findMany({ where: { companyId, worksiteId: { in: part } }, select: { worksiteId: true, status: true, costCents: true, startDate: true, endDate: true, dailyRateCents: true, fixedFeesCents: true } }))) {
    of(r.worksiteId)?.rentals.push({ status: r.status, costCents: r.costCents, startDate: r.startDate, endDate: r.endDate, dailyRateCents: r.dailyRateCents, fixedFeesCents: r.fixedFeesCents })
  }
  for (const b of await inChunks(ids, (part) => tx.equipmentBooking.findMany({
    where: { companyId, worksiteId: { in: part }, status: "RETURNED", equipment: { ownership: "OWNED", dailyCostCents: { not: null } } },
    select: { worksiteId: true, checkedOutAt: true, returnedAt: true, equipment: { select: { dailyCostCents: true } } },
  }))) {
    if (b.checkedOutAt && b.returnedAt && b.equipment.dailyCostCents !== null) of(b.worksiteId)?.ownedBookings.push({ checkedOutAt: b.checkedOutAt, returnedAt: b.returnedAt, dailyCostCents: b.equipment.dailyCostCents })
  }

  // Matériel propre utilisé sans coût journalier (fiches du catalogue créées à la réception, entre autres) : compté pour
  // être SIGNALÉ, jamais valorisé. Sorti (en cours) ou rendu : le matériel a été utilisé sur le chantier.
  for (const b of await inChunks(ids, (part) => tx.equipmentBooking.findMany({
    where: { companyId, worksiteId: { in: part }, status: { in: ["CHECKED_OUT", "RETURNED"] }, equipment: { ownership: "OWNED", dailyCostCents: null } },
    select: { worksiteId: true },
  }))) {
    const f = of(b.worksiteId)
    if (f) f.ownedBookingsWithoutCost++
  }

  // Véhicules : imputations explicites aux trajets rattachés au chantier ; mêmes critères que le coût par trajet (V3).
  const trips = await inChunks(ids, (part) => tx.mileageTrip.findMany({ where: { companyId, worksiteId: { in: part } }, select: { id: true, worksiteId: true } }))
  const tripSite = new Map(trips.map((t) => [t.id, t.worksiteId]))
  const allocations = await inChunks([...tripSite.keys()], (part) => tx.vehicleExpenseAllocation.findMany({ where: { companyId, mileageTripId: { in: part } }, select: { mileageTripId: true, amount: true, expense: true } }))
  const candidates: VehicleExpense[] = allocations.filter((a) => a.expense.status === "APPROVED" && a.expense.currency === "EUR").map((a) => a.expense)
  const states = await expenseSourceStates(tx, companyId, candidates)
  for (const a of allocations) {
    const admitted = a.expense.companyId === companyId && a.expense.status === "APPROVED" && a.expense.currency === "EUR" && states.get(a.expense.id)?.eligible === true
    of(a.mileageTripId ? tripSite.get(a.mileageTripId) ?? null : null)?.vehicleAllocations.push({ amountCents: decimalToCents(a.amount), admitted })
  }

  for (const a of await inChunks(ids, (part) => tx.supplierInvoiceAllocation.findMany({
    where: { companyId, worksiteId: { in: part }, cancelledAt: null },
    select: { worksiteId: true, nature: true, amountHTCents: true, supplierInvoice: { select: { status: true, _count: { select: { goodsReceipts: true, equipmentRentals: true } } } } },
  }))) {
    of(a.worksiteId)?.supplierAllocations.push({
      nature: a.nature, amountHTCents: a.amountHTCents, invoiceStatus: a.supplierInvoice.status,
      linkedElsewhere: a.supplierInvoice._count.goodsReceipts > 0 || a.supplierInvoice._count.equipmentRentals > 0,
    })
  }
  return facts as Map<string, WorksiteFacts>
}

export interface WorksiteMarginRow extends WorksiteMargin { worksiteId: string; name: string; status: string; archived: boolean; clientName: string }

/** Marges de tous les chantiers de l'entreprise (actifs seulement, sauf `includeArchived`), plafonnées à 500. */
export async function listWorksiteMargins(db: Db, companyId: string, opts: { includeArchived?: boolean } = {}): Promise<{ rows: WorksiteMarginRow[]; truncated: boolean }> {
  return db.$transaction(async (tx) => {
    const sites = await tx.worksite.findMany({
      where: { companyId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
      select: { id: true, name: true, status: true, archivedAt: true, clientId: true },
      orderBy: [{ name: "asc" }, { id: "asc" }], take: MAX_WORKSITES + 1,
    })
    const truncated = sites.length > MAX_WORKSITES
    const kept = sites.slice(0, MAX_WORKSITES)
    const clientIds = [...new Set(kept.map((site) => site.clientId))]
    const clients = await inChunks(clientIds, (ids) => tx.client.findMany({
      where: { companyId, id: { in: ids } },
      select: { id: true, name: true },
    }))
    const clientNames = new Map(clients.map((client) => [client.id, client.name]))
    const facts = await loadFacts(tx, companyId, kept.map((s) => s.id))
    const rows = kept.map((s) => ({ worksiteId: s.id, name: s.name, status: s.status, archived: s.archivedAt !== null, clientName: clientNames.get(s.clientId) ?? "—", ...computeWorksiteMargin(facts.get(s.id)!) }))
    return { rows, truncated }
  }, READ)
}

/** Détail d'un chantier : marge, historique complet des versions (lignes comprises), imputations, factures imputables. */
export async function getWorksiteBudget(db: Db, companyId: string, worksiteId: string) {
  return db.$transaction(async (tx) => {
    const site = await tx.worksite.findFirst({
      where: { id: worksiteId, companyId },
      select: { id: true, name: true, status: true, archivedAt: true, clientId: true },
    })
    if (!site) return null
    const { clientId, ...worksite } = site
    const client = await tx.client.findFirst({ where: { id: clientId, companyId }, select: { name: true } })
    const facts = await loadFacts(tx, companyId, [worksite.id])
    const margin = computeWorksiteMargin(facts.get(worksite.id)!)
    const budget = await tx.worksiteBudget.findFirst({
      where: { companyId, worksiteId: worksite.id },
      select: {
        id: true, currentRevision: true,
        revisions: {
          orderBy: { number: "desc" },
          select: { id: true, number: true, kind: true, reason: true, plannedRevenueCents: true, totalCostCents: true, createdById: true, createdAt: true, lines: { select: { nature: true, amountCents: true, label: true } } },
        },
      },
    })
    const authorIds = [...new Set(budget?.revisions.map((r) => r.createdById) ?? [])]
    const authors = new Map((authorIds.length ? await tx.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, email: true } }) : []).map((u) => [u.id, u.name ?? u.email]))
    const allocations = await tx.supplierInvoiceAllocation.findMany({
      where: { companyId, worksiteId: worksite.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 300,
      select: { id: true, nature: true, amountHTCents: true, label: true, createdAt: true, cancelledAt: true, supplierInvoice: { select: { id: true, number: true, supplierName: true, status: true, totalHTCents: true } } },
    })
    return { worksite: { ...worksite, clientName: client?.name ?? "—", archived: worksite.archivedAt !== null }, margin, budget: budget ? { ...budget, revisions: budget.revisions.map((r) => ({ ...r, authorName: authors.get(r.createdById) ?? "—" })) } : null, allocations }
  }, READ)
}

/**
 * Factures fournisseurs imputables : non refusées, non rattachées à une réception ni à une location, avec un reste
 * HT non encore imputé (toutes imputations actives confondues, tous chantiers). Plafonné à 200, plus récentes d'abord.
 */
export async function listAllocatableInvoices(db: Db, companyId: string) {
  const invoices = await db.supplierInvoice.findMany({
    where: { companyId, status: { in: ["PENDING", "VALIDATED"] }, goodsReceipts: { none: {} }, equipmentRentals: { none: {} } },
    orderBy: [{ date: "desc" }, { id: "desc" }], take: 400,
    select: { id: true, number: true, supplierName: true, date: true, status: true, totalHTCents: true },
  })
  const sums = invoices.length
    ? await db.supplierInvoiceAllocation.groupBy({ by: ["supplierInvoiceId"], where: { companyId, cancelledAt: null, supplierInvoiceId: { in: invoices.map((i) => i.id) } }, _sum: { amountHTCents: true } })
    : []
  const used = new Map(sums.map((s) => [s.supplierInvoiceId, s._sum.amountHTCents ?? BigInt(0)]))
  return invoices
    .map((i) => ({ ...i, remainingHTCents: i.totalHTCents - (used.get(i.id) ?? BigInt(0)) }))
    .filter((i) => i.remainingHTCents > BigInt(0))
    .slice(0, 200)
}
