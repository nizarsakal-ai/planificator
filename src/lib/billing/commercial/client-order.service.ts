// ═══════════════════════════════════════════════════════════════════════════
// 21/11/2026 — Bon de commande CLIENT (confirmation de commande) créé depuis un devis accepté.
// Lignes et totaux recopiés du devis (aucun recalcul divergent possible), numéro BC-AAAA-NNNN sans trou (compteur atomique),
// un seul bon actif par devis (index unique partiel en base), annulation datée et journalisée (jamais de suppression).
// `companyId` et `userId` viennent TOUJOURS de la session (actions serveur).
// ═══════════════════════════════════════════════════════════════════════════
import { Prisma, type PrismaClient } from "@prisma/client"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"

type Db = PrismaClient
export interface CommercialContext { companyId: string; userId: string }

export const CLIENT_ORDER_ERRORS = {
  quoteNotFound: "Devis introuvable.",
  quoteNotAccepted: "Seul un devis accepté (ou déjà converti) peut donner lieu à un bon de commande.",
  alreadyExists: "Un bon de commande est déjà actif pour ce devis : annulez-le avant d'en créer un autre.",
  notFound: "Bon de commande introuvable.",
  notCancellable: "Ce bon de commande est déjà annulé.",
  hasDeliveries: "Des bons de livraison actifs sont rattachés à ce bon de commande : annulez-les d'abord.",
} as const

export interface ClientOrderInput {
  issueDate: Date
  expectedDeliveryDate: Date | null
  /** null = adresse de livraison de la fiche client. */
  deliveryAddress: string | null
  notes: string | null
}

function isOneActivePerQuoteViolation(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false
  const target = Array.isArray(e.meta?.target) ? (e.meta?.target as unknown[]).map(String) : [String(e.meta?.target ?? "")]
  return target.includes("quoteId") || e.message.includes("client_orders_one_active_per_quote_key")
}

export async function createClientOrderFromQuote(db: Db, ctx: CommercialContext, quoteId: string, input: ClientOrderInput): Promise<LifecycleResult<{ id: string; number: string }>> {
  try {
    return await db.$transaction(async (tx) => {
      const q = await tx.quote.findFirst({
        where: { id: quoteId, companyId: ctx.companyId },
        select: {
          id: true, number: true, status: true, clientId: true, worksiteId: true, subject: true, clientPurchaseOrderRef: true, globalDiscountBp: true, vatReverseCharge: true,
          totalHT: true, totalVAT: true, totalTTC: true, client: { select: { deliveryAddress: true } },
          lines: { orderBy: { position: "asc" }, select: { articleId: true, designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true } },
        },
      })
      if (!q) return { ok: false as const, error: CLIENT_ORDER_ERRORS.quoteNotFound }
      if (q.status !== "ACCEPTED" && q.status !== "CONVERTED") return { ok: false as const, error: CLIENT_ORDER_ERRORS.quoteNotAccepted }
      const active = await tx.clientOrder.findFirst({ where: { companyId: ctx.companyId, quoteId: q.id, status: { not: "CANCELLED" } }, select: { id: true } })
      if (active) return { ok: false as const, error: CLIENT_ORDER_ERRORS.alreadyExists }
      const number = await nextDocumentNumber(tx, ctx.companyId, "CLIENT_ORDER")
      const order = await tx.clientOrder.create({
        data: {
          companyId: ctx.companyId, quoteId: q.id, clientId: q.clientId, worksiteId: q.worksiteId, number,
          issueDate: input.issueDate, expectedDeliveryDate: input.expectedDeliveryDate,
          clientReference: q.clientPurchaseOrderRef, deliveryAddress: input.deliveryAddress ?? q.client.deliveryAddress ?? null,
          subject: q.subject, notes: input.notes, globalDiscountBp: q.globalDiscountBp, vatReverseCharge: q.vatReverseCharge,
          totalHT: q.totalHT, totalVAT: q.totalVAT, totalTTC: q.totalTTC, createdById: ctx.userId,
          lines: { create: q.lines.map((l, i) => ({ ...l, position: i })) },
        },
        select: { id: true, number: true },
      })
      await tx.historyLog.create({
        data: { companyId: ctx.companyId, actorId: ctx.userId, action: "CREATED", entityType: "ClientOrder", entityId: order.id, detail: `Bon de commande ${order.number} créé depuis le devis ${q.number}`, newValue: { quoteId: q.id, totalTTC: q.totalTTC.toFixed(2) } },
      })
      return { ok: true as const, value: order }
    })
  } catch (e) {
    // Course entre deux créations simultanées : l'index unique partiel arbitre.
    if (isOneActivePerQuoteViolation(e)) return { ok: false, error: CLIENT_ORDER_ERRORS.alreadyExists }
    throw e
  }
}

export async function cancelClientOrder(db: Db, ctx: CommercialContext, orderId: string, now: Date): Promise<LifecycleResult> {
  return db.$transaction(async (tx) => {
    const o = await tx.clientOrder.findFirst({ where: { id: orderId, companyId: ctx.companyId }, select: { id: true, number: true, status: true } })
    if (!o) return { ok: false as const, error: CLIENT_ORDER_ERRORS.notFound }
    if (o.status === "CANCELLED") return { ok: false as const, error: CLIENT_ORDER_ERRORS.notCancellable }
    const deliveries = await tx.deliveryNote.count({ where: { companyId: ctx.companyId, clientOrderId: o.id, status: { not: "CANCELLED" } } })
    if (deliveries > 0) return { ok: false as const, error: CLIENT_ORDER_ERRORS.hasDeliveries }
    const u = await tx.clientOrder.updateMany({ where: { id: o.id, companyId: ctx.companyId, status: "ISSUED" }, data: { status: "CANCELLED", cancelledAt: now } })
    if (u.count !== 1) return { ok: false as const, error: CLIENT_ORDER_ERRORS.notCancellable }
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "STATUS_CHANGED", entityType: "ClientOrder", entityId: o.id, detail: `Bon de commande ${o.number} annulé`, oldValue: { status: "ISSUED" }, newValue: { status: "CANCELLED" } } })
    return { ok: true as const, value: undefined }
  })
}

export async function listClientOrders(db: Db, companyId: string, page = 1) {
  const pageSize = 50
  const [total, rows] = await Promise.all([
    db.clientOrder.count({ where: { companyId } }),
    db.clientOrder.findMany({
      where: { companyId }, orderBy: [{ issueDate: "desc" }, { number: "desc" }], skip: (Math.max(1, page) - 1) * pageSize, take: pageSize,
      select: { id: true, number: true, status: true, issueDate: true, totalTTC: true, client: { select: { name: true } }, worksite: { select: { name: true } }, quote: { select: { id: true, number: true } } },
    }),
  ])
  return { total, rows, page: Math.max(1, page), pageSize }
}

export async function getClientOrder(db: Db, companyId: string, id: string) {
  return db.clientOrder.findFirst({
    where: { id, companyId },
    select: {
      id: true, number: true, status: true, issueDate: true, expectedDeliveryDate: true, clientReference: true, deliveryAddress: true, subject: true, notes: true,
      globalDiscountBp: true, vatReverseCharge: true, totalHT: true, totalVAT: true, totalTTC: true, cancelledAt: true, createdAt: true,
      client: { select: { id: true, name: true } }, worksite: { select: { id: true, name: true } }, quote: { select: { id: true, number: true } },
      lines: { orderBy: { position: "asc" }, select: { designation: true, description: true, unit: true, quantity: true, unitPrice: true, vatRate: true, lineHT: true, discountBp: true } },
      deliveryNotes: { orderBy: { createdAt: "desc" }, select: { id: true, number: true, status: true, deliveryDate: true } },
    },
  })
}
