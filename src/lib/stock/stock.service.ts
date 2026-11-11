/**
 * Lot A Planificator V2 : service du stock et des achats. Toute lecture et écriture est bornée par `ctx.companyId`
 * (issu de la session, jamais d'une entrée client). Chaque écriture métier produit une ligne `HistoryLog` dans la même
 * transaction. Les règles viennent de `stock.core.ts` ; la base porte les mêmes invariants (CHECK, clés composites).
 *
 * Concurrence : une sortie décrémente par `updateMany … where quantityMilli >= q` (jamais de stock négatif, même si
 * deux sorties concurrentes lisent le même niveau) ; une réception met à jour chaque ligne de commande sous condition
 * de la valeur lue (sinon CONFLIT et ROLLBACK). Toute erreur après une écriture lève une exception (ROLLBACK).
 * Revue indépendante L1a (v2) : l'inventaire verrouille la ligne de stock (dépôt, article) avant de lire la quantité
 * (R1) ; une réception verrouille la commande avant de lire ses lignes et de calculer son état (R2). En READ COMMITTED,
 * la lecture qui suit l'obtention du verrou voit les écritures validées par la transaction précédente.
 */
import type { HistoryAction, Prisma, PrismaClient } from "@prisma/client"
import { businessYear } from "@/lib/billing/business-day"
import { serverNow } from "@/lib/billing/clock"
import {
  STOCK_ERRORS, matchOrder, orderTotalCents, planInventoryCount, planMovement, planReceipt,
  type MovementInput, type MovementType, type OrderStatus, type ReceiptRequestLine,
} from "@/lib/stock/stock.core"
import { formatMilli } from "@/lib/stock/quantity"
import { decimalToCents } from "@/lib/billing/money"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface StockServiceContext { companyId: string; userId: string }
export type StockResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

/** Erreur métier levée DANS une transaction pour forcer le ROLLBACK, puis convertie en résultat. */
class StockFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "StockFailure" }
}
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<StockResult<T>> {
  try {
    return { ok: true, value: await db.$transaction(fn) }
  } catch (e) {
    if (e instanceof StockFailure) return { ok: false, error: e.userMessage }
    throw e
  }
}
const fail = (m: string): never => { throw new StockFailure(m) }

const PREFIX = { PURCHASE_ORDER: "CA", GOODS_RECEIPT: "BR" } as const
/** Numéro séquentiel annuel par entreprise (compteur atomique existant `document_counters`, types dédiés). */
async function nextNumber(tx: Tx, companyId: string, type: keyof typeof PREFIX): Promise<string> {
  const year = businessYear(serverNow())
  const c = await tx.documentCounter.upsert({
    where: { companyId_type_year: { companyId, type, year } },
    create: { companyId, type, year, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
  })
  return `${PREFIX[type]}-${year}-${String(c.lastValue).padStart(4, "0")}`
}

async function audit(tx: Tx, ctx: StockServiceContext, a: { action: HistoryAction; entityType: string; entityId: string; detail: string; worksiteId?: string | null; newValue?: Prisma.InputJsonValue }) {
  await tx.historyLog.create({
    data: { companyId: ctx.companyId, actorId: ctx.userId, worksiteId: a.worksiteId ?? null, action: a.action, entityType: a.entityType, entityId: a.entityId, detail: a.detail, newValue: a.newValue },
  })
}

// ─────────────────────────────── Dépôts ───────────────────────────────

export async function createWarehouse(db: Db, ctx: StockServiceContext, input: { name: string; address?: string | null }): Promise<StockResult<{ id: string }>> {
  const name = input.name.trim()
  const address = input.address?.trim() || null
  if (!name || name.length > 120 || (address && address.length > 500)) return { ok: false, error: "Nom ou adresse de dépôt invalide." }
  return inTx(db, async (tx) => {
    const exists = await tx.warehouse.findFirst({ where: { companyId: ctx.companyId, name }, select: { id: true } })
    if (exists) fail("Un dépôt porte déjà ce nom.")
    const w = await tx.warehouse.create({ data: { companyId: ctx.companyId, name, address }, select: { id: true } })
    await audit(tx, ctx, { action: "CREATED", entityType: "Warehouse", entityId: w.id, detail: `Dépôt « ${name} » créé` })
    return w
  })
}

export async function setWarehouseActive(db: Db, ctx: StockServiceContext, warehouseId: string, active: boolean): Promise<StockResult> {
  return inTx(db, async (tx) => {
    const r = await tx.warehouse.updateMany({ where: { id: warehouseId, companyId: ctx.companyId }, data: { active } })
    if (r.count !== 1) fail(STOCK_ERRORS.notFound)
    await audit(tx, ctx, { action: "UPDATED", entityType: "Warehouse", entityId: warehouseId, detail: active ? "Dépôt réactivé" : "Dépôt désactivé" })
    return undefined
  })
}

async function requireArticle(tx: Tx, ctx: StockServiceContext, articleId: string) {
  return (await tx.article.findFirst({ where: { id: articleId, companyId: ctx.companyId }, select: { id: true, designation: true, unit: true, unitPrice: true } })) ?? fail(STOCK_ERRORS.notFound)
}
async function requireWarehouse(tx: Tx, ctx: StockServiceContext, warehouseId: string, activeRequired: boolean) {
  const w = (await tx.warehouse.findFirst({ where: { id: warehouseId, companyId: ctx.companyId }, select: { id: true, name: true, active: true } })) ?? fail(STOCK_ERRORS.notFound)
  if (activeRequired && !w.active) fail(STOCK_ERRORS.inactiveWarehouse)
  return w
}
/** Chantier de l'entreprise ; non archivé pour une nouvelle imputation (revue indépendante), archivé toléré pour la
 * réception d'une commande passée avant l'archivage. */
async function requireWorksite(tx: Tx, ctx: StockServiceContext, worksiteId: string, allowArchived = false) {
  return (await tx.worksite.findFirst({ where: { id: worksiteId, companyId: ctx.companyId, ...(allowArchived ? {} : { archivedAt: null }) }, select: { id: true, name: true } })) ?? fail(STOCK_ERRORS.notFound)
}

/** Seuil d'alerte d'un article dans un dépôt (null = aucun seuil). */
export async function setThreshold(db: Db, ctx: StockServiceContext, input: { warehouseId: string; articleId: string; minQuantityMilli: number | null }): Promise<StockResult> {
  const min = input.minQuantityMilli
  if (min !== null && (!Number.isSafeInteger(min) || min < 0)) return { ok: false, error: "Seuil invalide." }
  return inTx(db, async (tx) => {
    await requireWarehouse(tx, ctx, input.warehouseId, false)
    const article = await requireArticle(tx, ctx, input.articleId)
    await tx.stockLevel.upsert({
      where: { warehouseId_articleId: { warehouseId: input.warehouseId, articleId: input.articleId } },
      create: { companyId: ctx.companyId, warehouseId: input.warehouseId, articleId: input.articleId, minQuantityMilli: min },
      update: { minQuantityMilli: min },
    })
    await audit(tx, ctx, { action: "UPDATED", entityType: "StockLevel", entityId: `${input.warehouseId}:${input.articleId}`, detail: `Seuil de « ${article.designation} » : ${min === null ? "aucun" : formatMilli(min)}` })
    return undefined
  })
}

// ─────────────────────────────── Mouvements ───────────────────────────────

/** Applique les variations d'un mouvement : décrément conditionnel (jamais négatif), incrément par upsert. */
async function applyDeltas(tx: Tx, ctx: StockServiceContext, articleId: string, deltas: { warehouseId: string; deltaMilli: number }[]) {
  for (const d of deltas) {
    if (d.deltaMilli < 0) {
      const r = await tx.stockLevel.updateMany({
        where: { companyId: ctx.companyId, warehouseId: d.warehouseId, articleId, quantityMilli: { gte: -d.deltaMilli } },
        data: { quantityMilli: { decrement: -d.deltaMilli } },
      })
      if (r.count !== 1) fail(STOCK_ERRORS.insufficient)
    } else {
      await tx.stockLevel.upsert({
        where: { warehouseId_articleId: { warehouseId: d.warehouseId, articleId } },
        create: { companyId: ctx.companyId, warehouseId: d.warehouseId, articleId, quantityMilli: d.deltaMilli },
        update: { quantityMilli: { increment: d.deltaMilli } },
      })
    }
  }
}

async function recordMovementTx(tx: Tx, ctx: StockServiceContext, input: MovementInput & { articleId: string; worksiteId?: string | null; goodsReceiptLineId?: string | null; allowArchivedWorksite?: boolean }) {
  const plan = planMovement(input)
  if (!plan.ok) fail(plan.error)
  const article = await requireArticle(tx, ctx, input.articleId)
  // Les dépôts doivent être actifs pour recevoir ou céder du stock (un dépôt désactivé reste consultable).
  if (input.fromWarehouseId) await requireWarehouse(tx, ctx, input.fromWarehouseId, true)
  if (input.toWarehouseId) await requireWarehouse(tx, ctx, input.toWarehouseId, true)
  const worksite = input.worksiteId ? await requireWorksite(tx, ctx, input.worksiteId, input.allowArchivedWorksite === true) : null
  await applyDeltas(tx, ctx, article.id, (plan as { ok: true; value: { warehouseId: string; deltaMilli: number }[] }).value)
  const m = await tx.stockMovement.create({
    data: {
      companyId: ctx.companyId, type: input.type, articleId: article.id, quantityMilli: input.quantityMilli,
      fromWarehouseId: input.fromWarehouseId || null, toWarehouseId: input.toWarehouseId || null,
      worksiteId: worksite?.id ?? null, goodsReceiptLineId: input.goodsReceiptLineId ?? null,
      reason: input.reason?.trim() || null, createdById: ctx.userId,
    },
    select: { id: true },
  })
  const label: Record<MovementType, string> = { RECEIPT: "Entrée", ISSUE: "Sortie", TRANSFER: "Transfert", ADJUSTMENT: "Ajustement" }
  await audit(tx, ctx, {
    action: "CREATED", entityType: "StockMovement", entityId: m.id, worksiteId: worksite?.id ?? null,
    detail: `${label[input.type]} de ${formatMilli(input.quantityMilli)} ${article.unit} « ${article.designation} »${worksite ? ` (chantier ${worksite.name})` : ""}`,
  })
  return m
}

/** Mouvement manuel (entrée hors commande, sortie vers un chantier, transfert, ajustement motivé). */
export async function recordMovement(db: Db, ctx: StockServiceContext, input: MovementInput & { articleId: string; worksiteId?: string | null }): Promise<StockResult<{ id: string }>> {
  return inTx(db, (tx) => recordMovementTx(tx, ctx, { ...input, goodsReceiptLineId: null }))
}

/**
 * Verrou de ligne (FOR UPDATE) du niveau de stock (dépôt, article) de l'entreprise, jusqu'à la fin de la transaction.
 * Renvoie la quantité VERROUILLÉE, ou null si la ligne n'existe pas (rien n'est alors verrouillé).
 */
async function lockStockLevel(tx: Tx, ctx: StockServiceContext, warehouseId: string, articleId: string): Promise<number | null> {
  const rows = await tx.$queryRaw<{ quantityMilli: number }[]>`SELECT "quantityMilli" FROM "stock_levels" WHERE "companyId" = ${ctx.companyId} AND "warehouseId" = ${warehouseId} AND "articleId" = ${articleId} FOR UPDATE`
  return rows.length === 1 ? rows[0].quantityMilli : null
}

/**
 * Inventaire : la quantité comptée remplace la quantité enregistrée par un ajustement tracé (aucun si identique).
 * R1 (revue indépendante) : deux inventaires, ou un inventaire et un mouvement, sur le même couple (dépôt, article) sont
 * SÉRIALISÉS par le verrou de la ligne de stock, pris AVANT la lecture de la quantité : l'écart est calculé sur la valeur
 * verrouillée, puis appliqué une seule fois par le mouvement d'ajustement (même transaction, même audit). Ligne absente
 * et comptage positif : création à zéro sous la contrainte unique (ON CONFLICT DO NOTHING : une création concurrente
 * attend la validation de l'autre), puis verrou et relecture ; toute erreur ultérieure annule aussi cette création.
 */
export async function recordInventoryCount(db: Db, ctx: StockServiceContext, input: { warehouseId: string; articleId: string; countedMilli: number; reason: string }): Promise<StockResult<{ id: string } | null>> {
  return inTx(db, async (tx) => {
    await requireWarehouse(tx, ctx, input.warehouseId, true)
    await requireArticle(tx, ctx, input.articleId)
    let recorded = await lockStockLevel(tx, ctx, input.warehouseId, input.articleId)
    if (recorded === null && input.countedMilli > 0) {
      await tx.stockLevel.createMany({ data: [{ companyId: ctx.companyId, warehouseId: input.warehouseId, articleId: input.articleId, quantityMilli: 0 }], skipDuplicates: true })
      recorded = (await lockStockLevel(tx, ctx, input.warehouseId, input.articleId)) ?? fail(STOCK_ERRORS.conflict)
    }
    const plan = planInventoryCount(recorded ?? 0, input.countedMilli, input.warehouseId, input.reason)
    if (!plan.ok) fail(plan.error)
    const adj = (plan as { ok: true; value: MovementInput | null }).value
    if (!adj) return null
    return recordMovementTx(tx, ctx, { ...adj, articleId: input.articleId, goodsReceiptLineId: null })
  })
}

// ─────────────────────────────── Commandes d'achat ───────────────────────────────

/** Prix unitaire null : prix de l'article (obligatoire alors) ; une ligne sans article exige un prix explicite. */
export interface PurchaseOrderLineInput { articleId?: string | null; designation: string; quantityMilli: number; unitPriceCents: number | null }

export async function createPurchaseOrder(db: Db, ctx: StockServiceContext, input: {
  supplierId: string; warehouseId: string; worksiteId?: string | null; expectedAt?: Date | null; notes?: string | null; lines: PurchaseOrderLineInput[]
}): Promise<StockResult<{ id: string; number: string }>> {
  const lines = input.lines.filter((l) => l.designation.trim() || l.articleId)
  if (lines.length === 0) return { ok: false, error: STOCK_ERRORS.emptyOrder }
  if (lines.length > 200) return { ok: false, error: "Trop de lignes (200 au plus)." }
  for (const l of lines) {
    if (!Number.isSafeInteger(l.quantityMilli) || l.quantityMilli <= 0 || (l.unitPriceCents !== null && (!Number.isSafeInteger(l.unitPriceCents) || l.unitPriceCents < 0 || l.unitPriceCents > 2_000_000_000))) {
      return { ok: false, error: "Quantité ou prix unitaire invalide." }
    }
  }
  const notes = input.notes?.trim() || null
  if (notes && notes.length > 2000) return { ok: false, error: "Notes trop longues." }
  return inTx(db, async (tx) => {
    const supplier = (await tx.supplier.findFirst({ where: { id: input.supplierId, companyId: ctx.companyId, active: true }, select: { id: true, name: true } })) ?? fail(STOCK_ERRORS.notFound)
    await requireWarehouse(tx, ctx, input.warehouseId, true)
    if (input.worksiteId) await requireWorksite(tx, ctx, input.worksiteId)
    const resolved = []
    for (const [i, l] of lines.entries()) {
      const article = l.articleId ? await requireArticle(tx, ctx, l.articleId) : null
      const designation = (l.designation.trim() || article?.designation || "").slice(0, 500)
      if (!designation) fail("Désignation manquante.")
      const unitPriceCents = l.unitPriceCents ?? (article ? Number(decimalToCents(article.unitPrice)) : fail(`Prix unitaire manquant (ligne ${i + 1}).`))
      // Même borne pour un prix repris de l'article (Decimal(10,2) peut dépasser la colonne entière des centimes).
      if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 2_000_000_000) fail(`Prix unitaire hors limites (ligne ${i + 1}).`)
      resolved.push({ position: i, articleId: article?.id ?? null, designation, quantityMilli: l.quantityMilli, unitPriceCents })
    }
    const number = await nextNumber(tx, ctx.companyId, "PURCHASE_ORDER")
    const po = await tx.purchaseOrder.create({
      data: {
        companyId: ctx.companyId, number, supplierId: supplier.id, warehouseId: input.warehouseId, worksiteId: input.worksiteId || null,
        expectedAt: input.expectedAt ?? null, notes, totalHTCents: orderTotalCents(resolved), createdById: ctx.userId,
        lines: { create: resolved },
      },
      select: { id: true, number: true },
    })
    await audit(tx, ctx, { action: "CREATED", entityType: "PurchaseOrder", entityId: po.id, worksiteId: input.worksiteId || null, detail: `Commande d'achat ${number} créée (brouillon) pour ${supplier.name}` })
    return po
  })
}

export async function markOrdered(db: Db, ctx: StockServiceContext, orderId: string, now: Date = serverNow()): Promise<StockResult> {
  return inTx(db, async (tx) => {
    const r = await tx.purchaseOrder.updateMany({ where: { id: orderId, companyId: ctx.companyId, status: "DRAFT" }, data: { status: "ORDERED", orderedAt: now } })
    if (r.count !== 1) fail(STOCK_ERRORS.orderNotEditable)
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "PurchaseOrder", entityId: orderId, detail: "Commande d'achat passée au fournisseur" })
    return undefined
  })
}

/** Annulation : brouillon, ou commande passée sans aucune réception. */
export async function cancelOrder(db: Db, ctx: StockServiceContext, orderId: string): Promise<StockResult> {
  return inTx(db, async (tx) => {
    const received = await tx.purchaseOrderLine.count({ where: { purchaseOrder: { id: orderId, companyId: ctx.companyId }, receivedMilli: { gt: 0 } } })
    if (received > 0) fail(STOCK_ERRORS.orderNotReceivable)
    const r = await tx.purchaseOrder.updateMany({ where: { id: orderId, companyId: ctx.companyId, status: { in: ["DRAFT", "ORDERED"] } }, data: { status: "CANCELLED" } })
    if (r.count !== 1) fail(STOCK_ERRORS.orderNotReceivable)
    await audit(tx, ctx, { action: "STATUS_CHANGED", entityType: "PurchaseOrder", entityId: orderId, detail: "Commande d'achat annulée" })
    return undefined
  })
}

async function requireSupplierInvoiceForOrder(tx: Tx, ctx: StockServiceContext, supplierInvoiceId: string, supplierId: string) {
  const inv = (await tx.supplierInvoice.findFirst({ where: { id: supplierInvoiceId, companyId: ctx.companyId }, select: { id: true, supplierId: true, number: true } })) ?? fail(STOCK_ERRORS.notFound)
  if (inv.supplierId !== supplierId) fail(STOCK_ERRORS.supplierInvoiceMismatch)
  return inv
}

/**
 * Réception (partielle ou totale) : bon de réception numéroté, quantité reçue de chaque ligne, entrée en stock des
 * lignes liées à un article (mouvement RECEIPT relié à la ligne de réception), nouvel état de la commande.
 */
export async function receiveGoods(db: Db, ctx: StockServiceContext, orderId: string, input: {
  lines: ReceiptRequestLine[]; warehouseId?: string | null; supplierInvoiceId?: string | null; notes?: string | null; receivedAt?: Date
}): Promise<StockResult<{ id: string; number: string; status: OrderStatus }>> {
  const notes = input.notes?.trim() || null
  if (notes && notes.length > 2000) return { ok: false, error: "Notes trop longues." }
  return inTx(db, async (tx) => {
    // R2 (revue indépendante) : verrou de la commande AVANT la lecture des lignes et le calcul de l'état. Deux réceptions
    // de la même commande sont sérialisées : la seconde lit les lignes et le statut validés par la première, donc l'état
    // final (soldée ou partielle) est calculé sur des lignes cohérentes. Les comparaisons de ligne et de statut restent.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "purchase_orders" WHERE "id" = ${orderId} AND "companyId" = ${ctx.companyId} FOR UPDATE`
    if (locked.length !== 1) fail(STOCK_ERRORS.notFound)
    const order = (await tx.purchaseOrder.findFirst({
      where: { id: orderId, companyId: ctx.companyId },
      select: { id: true, number: true, status: true, supplierId: true, warehouseId: true, worksiteId: true, lines: { select: { id: true, quantityMilli: true, receivedMilli: true, unitPriceCents: true, articleId: true } } },
    })) ?? fail(STOCK_ERRORS.notFound)
    const plan = planReceipt(order.status, order.lines, input.lines)
    if (!plan.ok) fail(plan.error)
    const { lines, nextStatus } = (plan as { ok: true; value: { lines: ReceiptRequestLine[]; nextStatus: OrderStatus } }).value
    const warehouseId = input.warehouseId || order.warehouseId
    await requireWarehouse(tx, ctx, warehouseId, true)
    const invoice = input.supplierInvoiceId ? await requireSupplierInvoiceForOrder(tx, ctx, input.supplierInvoiceId, order.supplierId) : null
    const number = await nextNumber(tx, ctx.companyId, "GOODS_RECEIPT")
    const receipt = await tx.goodsReceipt.create({
      data: { companyId: ctx.companyId, number, purchaseOrderId: order.id, warehouseId, supplierInvoiceId: invoice?.id ?? null, receivedAt: input.receivedAt ?? serverNow(), notes, createdById: ctx.userId },
      select: { id: true },
    })
    for (const r of lines) {
      const line = order.lines.find((l) => l.id === r.orderLineId)!
      const upd = await tx.purchaseOrderLine.updateMany({ where: { id: line.id, purchaseOrderId: order.id, receivedMilli: line.receivedMilli }, data: { receivedMilli: line.receivedMilli + r.quantityMilli } })
      if (upd.count !== 1) fail(STOCK_ERRORS.conflict)
      const rl = await tx.goodsReceiptLine.create({ data: { goodsReceiptId: receipt.id, orderLineId: line.id, quantityMilli: r.quantityMilli }, select: { id: true } })
      if (line.articleId) {
        await recordMovementTx(tx, ctx, { type: "RECEIPT", quantityMilli: r.quantityMilli, toWarehouseId: warehouseId, articleId: line.articleId, worksiteId: order.worksiteId, allowArchivedWorksite: true, goodsReceiptLineId: rl.id, reason: `Réception ${number} (commande ${order.number})` })
      }
    }
    const st = await tx.purchaseOrder.updateMany({ where: { id: order.id, companyId: ctx.companyId, status: order.status }, data: { status: nextStatus } })
    if (st.count !== 1) fail(STOCK_ERRORS.conflict)
    await audit(tx, ctx, { action: "CREATED", entityType: "GoodsReceipt", entityId: receipt.id, worksiteId: order.worksiteId, detail: `Réception ${number} de la commande ${order.number} (${lines.length} ligne(s)) ; commande ${nextStatus === "RECEIVED" ? "soldée" : "partiellement reçue"}${warehouseId !== order.warehouseId ? " ; reçue dans un autre dépôt que celui de la commande" : ""}` })
    return { id: receipt.id, number, status: nextStatus }
  })
}

/** Lie (ou délie, null) une facture fournisseur à une réception, pour le rapprochement. */
export async function linkSupplierInvoice(db: Db, ctx: StockServiceContext, receiptId: string, supplierInvoiceId: string | null): Promise<StockResult> {
  return inTx(db, async (tx) => {
    const receipt = (await tx.goodsReceipt.findFirst({ where: { id: receiptId, companyId: ctx.companyId }, select: { id: true, number: true, purchaseOrder: { select: { supplierId: true } } } })) ?? fail(STOCK_ERRORS.notFound)
    const inv = supplierInvoiceId ? await requireSupplierInvoiceForOrder(tx, ctx, supplierInvoiceId, receipt.purchaseOrder.supplierId) : null
    await tx.goodsReceipt.updateMany({ where: { id: receipt.id, companyId: ctx.companyId }, data: { supplierInvoiceId: inv?.id ?? null } })
    await audit(tx, ctx, { action: "UPDATED", entityType: "GoodsReceipt", entityId: receipt.id, detail: inv ? `Réception ${receipt.number} liée à la facture fournisseur ${inv.number}` : `Facture fournisseur déliée de la réception ${receipt.number}` })
    return undefined
  })
}

/** Rapprochement commande, réception et facture (factures distinctes liées aux réceptions de la commande). */
export async function orderMatch(db: Db, ctx: StockServiceContext, orderId: string, toleranceCents = BigInt("100")) {
  const order = await db.purchaseOrder.findFirst({
    where: { id: orderId, companyId: ctx.companyId },
    select: { lines: { select: { id: true, quantityMilli: true, receivedMilli: true, unitPriceCents: true } }, receipts: { select: { supplierInvoiceId: true } } },
  })
  if (!order) return null
  const ids = [...new Set(order.receipts.map((r) => r.supplierInvoiceId).filter((x): x is string => !!x))]
  const invoices = ids.length ? await db.supplierInvoice.findMany({ where: { companyId: ctx.companyId, id: { in: ids } }, select: { totalHTCents: true } }) : []
  const invoicedHTCents = invoices.reduce((s, i) => s + BigInt(i.totalHTCents), BigInt("0"))
  return matchOrder({ lines: order.lines, invoicedHTCents, toleranceCents })
}

// ─────────────────────────────── Catalogue événementiel ───────────────────────────────

/**
 * Crée les articles du catalogue événementiel absents de l'entreprise (prix 0 € HT, TVA 20 %, à compléter dans
 * Articles). Idempotent : un article déjà présent (même référence, ou même désignation) n'est ni recréé ni modifié ;
 * un article désactivé de même référence est réactivé.
 */
export async function importEventCatalog(db: Db, ctx: StockServiceContext, items: { reference: string; designation: string; unit: string }[]): Promise<StockResult<{ created: number; reactivated: number }>> {
  return inTx(db, async (tx) => {
    const existing = await tx.article.findMany({ where: { companyId: ctx.companyId }, select: { id: true, reference: true, designation: true, active: true } })
    const byRef = new Map(existing.filter((a) => a.reference).map((a) => [a.reference!, a]))
    const byName = new Set(existing.map((a) => a.designation.trim().toLowerCase()))
    let created = 0
    let reactivated = 0
    for (const it of items) {
      const same = byRef.get(it.reference)
      if (same) {
        if (!same.active) { await tx.article.update({ where: { id: same.id }, data: { active: true } }); reactivated++ }
        continue
      }
      if (byName.has(it.designation.trim().toLowerCase())) continue
      await tx.article.create({ data: { companyId: ctx.companyId, reference: it.reference, designation: it.designation, unit: it.unit, unitPrice: 0, vatRate: 20 } })
      created++
    }
    if (created || reactivated) await audit(tx, ctx, { action: "CREATED", entityType: "Article", entityId: "catalogue-evenementiel", detail: `Catalogue événementiel : ${created} article(s) créé(s), ${reactivated} réactivé(s)` })
    return { created, reactivated }
  })
}

/**
 * Article de stock d'un élément du catalogue événementiel : l'existant (même référence, ou même désignation) ou un
 * article créé à la volée au premier mouvement (prix 0 € HT à compléter dans Articles). Retourne son identifiant.
 */
export async function ensureEventArticle(db: Db, ctx: StockServiceContext, item: { reference: string; designation: string; unit: string }): Promise<string> {
  const find = () => db.article.findFirst({
    where: { companyId: ctx.companyId, OR: [{ reference: item.reference }, { designation: { equals: item.designation, mode: "insensitive" } }] },
    orderBy: { active: "desc" }, select: { id: true },
  })
  const found = await find()
  if (found) return found.id
  const r = await importEventCatalog(db, ctx, [item])
  if (!r.ok) throw new StockFailure(r.error)
  return (await find())?.id ?? fail("Article introuvable.")
}
