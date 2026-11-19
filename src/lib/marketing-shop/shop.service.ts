/**
 * Lot I Planificator V2 : service de la boutique de SIMULATION. Toute lecture et écriture est bornée par `ctx.companyId`
 * (session) ; chaque écriture est auditée (HistoryLog : opération et identifiants) dans sa transaction.
 *
 * - Aucun paiement, aucune facture, aucun devis, aucun mouvement de stock : seules les tables du lot I sont écrites.
 * - Commande : client actif et articles actifs de la société ; libellé, unité, prix HT et TVA FIGÉS depuis l'article au
 *   moment de la commande ; promotion relue sous verrou partagé (une désactivation concurrente attend) ; totaux calculés
 *   en centimes par le moteur monétaire existant ; la base revérifie les totaux à la validation.
 * - Idempotence : clé unique par société. Rejeu de la même clé avec les mêmes paramètres ⇒ commande existante rendue,
 *   sans doublon (y compris pour deux envois simultanés, départagés par l'unicité) ; mêmes clé et autres paramètres ⇒ refus.
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { serverNow } from "@/lib/billing/clock"
import { MoneyError, decimalToCents, storedVatRateToBp } from "@/lib/billing/money"
import { parisToday, parseDay } from "@/lib/equipment/equipment.core"
import {
  IDEMPOTENCY_KEY, PROMO_STATE_ERROR, SHOP_ERRORS, computeOrder, normalizePromoCode, parsePromoPercent, promotionState, requestSha256, validateOrderRequest,
  type PricedLine,
} from "@/lib/marketing-shop/shop.core"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface ShopContext { companyId: string; userId: string }
export type ShopResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

class ShopFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "ShopFailure" }
}
const fail = (m: string): never => { throw new ShopFailure(m) }
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"

export const SHOP_AUDIT = {
  promotionCreated: "Promotion boutique créée.",
  promotionActivated: "Promotion boutique activée.",
  promotionDeactivated: "Promotion boutique désactivée.",
  orderCreated: "Commande boutique de simulation enregistrée.",
} as const
async function audit(tx: Tx, ctx: ShopContext, action: "CREATED" | "STATUS_CHANGED", entityType: string, entityId: string, detail: string) {
  await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action, entityType, entityId, detail } })
}

export async function createPromotion(db: Db, ctx: ShopContext, input: { code: string; percent: string; validFrom: string; validUntil: string }): Promise<ShopResult<{ id: string }>> {
  const code = normalizePromoCode(input.code)
  if (!code.ok) return code
  const pct = parsePromoPercent(input.percent)
  if (!pct.ok) return pct
  const from = parseDay(input.validFrom), until = parseDay(input.validUntil)
  if (!from || !until || until.getTime() < from.getTime()) return { ok: false, error: SHOP_ERRORS.promoWindow }
  try {
    return {
      ok: true,
      value: await db.$transaction(async (tx) => {
        const p = await tx.shopPromotion.create({ data: { companyId: ctx.companyId, code: code.value, percentBp: pct.value, active: true, validFrom: from, validUntil: until, createdById: ctx.userId }, select: { id: true } })
        await audit(tx, ctx, "CREATED", "ShopPromotion", p.id, SHOP_AUDIT.promotionCreated)
        return { id: p.id }
      }),
    }
  } catch (e) {
    if (isUnique(e)) return { ok: false, error: SHOP_ERRORS.promoExists }
    throw e
  }
}

export async function setPromotionActive(db: Db, ctx: ShopContext, promotionId: string, active: boolean): Promise<ShopResult> {
  return db.$transaction(async (tx) => {
    const u = await tx.shopPromotion.updateMany({ where: { id: promotionId, companyId: ctx.companyId }, data: { active } })
    if (u.count !== 1) return { ok: false as const, error: SHOP_ERRORS.notFound }
    await audit(tx, ctx, "STATUS_CHANGED", "ShopPromotion", promotionId, active ? SHOP_AUDIT.promotionActivated : SHOP_AUDIT.promotionDeactivated)
    return { ok: true as const, value: undefined }
  })
}

export interface CreateOrderInput { idempotencyKey: string; clientId: string; lines: { articleId: string; quantity: string }[]; promoCode: string }
export type CreatedOrder = { id: string; replayed: boolean }

/** Commande existante pour cette clé : rendue si les paramètres sont identiques, refus sinon. */
async function replay(db: Db | Tx, ctx: ShopContext, key: string, sha: string): Promise<ShopResult<CreatedOrder> | null> {
  const prior = await db.shopOrder.findFirst({ where: { companyId: ctx.companyId, idempotencyKey: key }, select: { id: true, requestSha256: true } })
  if (!prior) return null
  return prior.requestSha256 === sha ? { ok: true, value: { id: prior.id, replayed: true } } : { ok: false, error: SHOP_ERRORS.idempotencyMismatch }
}

export async function createOrder(db: Db, ctx: ShopContext, input: CreateOrderInput, now: Date = serverNow()): Promise<ShopResult<CreatedOrder>> {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) return { ok: false, error: SHOP_ERRORS.idempotencyKey }
  const req = validateOrderRequest(input)
  if (!req.ok) return req
  const sha = requestSha256(req.value)
  const before = await replay(db, ctx, input.idempotencyKey, sha)
  if (before) return before
  try {
    return {
      ok: true,
      value: await db.$transaction(async (tx) => {
        const client = (await tx.client.findFirst({ where: { id: req.value.clientId, companyId: ctx.companyId, active: true }, select: { id: true } })) ?? fail(SHOP_ERRORS.client)
        // Promotion relue sous verrou partagé : une désactivation concurrente attend la fin de la commande.
        let promo: { id: string; code: string; percentBp: number } | null = null
        if (req.value.promoCode) {
          const rows = await tx.$queryRaw<{ id: string; code: string; percentBp: number; active: boolean; validFrom: Date; validUntil: Date }[]>`
            SELECT "id", "code", "percentBp", "active", "validFrom", "validUntil" FROM "shop_promotions" WHERE "companyId" = ${ctx.companyId} AND "code" = ${req.value.promoCode} FOR SHARE`
          const p = rows[0] ?? fail(SHOP_ERRORS.promoUnknown)
          const state = promotionState(p, parisToday(now))
          if (state !== "VALID") fail(PROMO_STATE_ERROR[state as Exclude<typeof state, "VALID">])
          promo = { id: p.id, code: p.code, percentBp: p.percentBp }
        }
        const ids = [...new Set(req.value.lines.map((l) => l.articleId))]
        const articles = await tx.article.findMany({ where: { companyId: ctx.companyId, active: true, id: { in: ids } }, select: { id: true, designation: true, unit: true, unitPrice: true, vatRate: true } })
        const byId = new Map(articles.map((a) => [a.id, a]))
        const priced: PricedLine[] = req.value.lines.map((l) => {
          const a = byId.get(l.articleId) ?? fail(SHOP_ERRORS.article)
          let unitPriceCents: bigint, vatRateBp: number
          try { unitPriceCents = decimalToCents(a.unitPrice); vatRateBp = storedVatRateToBp(a.vatRate) } catch { return fail(SHOP_ERRORS.articlePrice) }
          if (unitPriceCents < BigInt(0)) fail(SHOP_ERRORS.articlePrice)
          return { articleId: a.id, designation: a.designation, unit: a.unit, quantity: l.quantity, unitPriceCents, vatRateBp }
        })
        let order: ReturnType<typeof computeOrder>
        try { order = computeOrder(priced, promo?.percentBp ?? 0) } catch (e) { if (e instanceof MoneyError) fail(SHOP_ERRORS.amount); throw e }
        const o = await tx.shopOrder.create({
          data: {
            companyId: ctx.companyId, idempotencyKey: input.idempotencyKey, requestSha256: sha, clientId: client.id,
            promotionId: promo?.id ?? null, promotionCode: promo?.code ?? null, promotionPercentBp: promo?.percentBp ?? 0,
            // Nombre de lignes figé (1 à 20) : la base exige exactement ce nombre à la validation (panier figé).
            lineCount: order.lines.length,
            subtotalCents: order.subtotalCents, discountCents: order.discountCents, totalHTCents: order.totalHTCents, totalVATCents: order.totalVATCents, totalTTCCents: order.totalTTCCents,
            createdById: ctx.userId,
          },
          select: { id: true },
        })
        await tx.shopOrderLine.createMany({
          data: order.lines.map((l) => ({
            companyId: ctx.companyId, orderId: o.id, position: l.position, articleId: l.articleId, designation: l.designation, unit: l.unit, quantity: l.quantity,
            unitPriceCents: l.unitPriceCents, vatRateBp: l.vatRateBp, grossCents: l.grossCents, discountCents: l.discountCents, netCents: l.netCents, vatCents: l.vatCents,
          })),
        })
        await audit(tx, ctx, "CREATED", "ShopOrder", o.id, SHOP_AUDIT.orderCreated)
        // v3 : contrôle différé du panier figé (nombre de lignes et totaux) forcé ICI, dans le corps de la transaction :
        // un échec remonte avant l'annonce du succès (Prisma 5.22 ne remonte pas toujours un rejet levé à la validation),
        // la transaction est annulée en entier, aucun succès fantôme. Instruction SQL constante et ciblée.
        await tx.$executeRaw`SET CONSTRAINTS shop_orders_totals_guard, shop_order_lines_totals_guard IMMEDIATE`
        return { id: o.id, replayed: false }
      }),
    }
  } catch (e) {
    if (e instanceof ShopFailure) return { ok: false, error: e.userMessage }
    // Envoi simultané de la même clé : l'unicité (société, clé) départage ; le perdant rend la commande gagnante.
    if (isUnique(e)) return (await replay(db, ctx, input.idempotencyKey, sha)) ?? { ok: false, error: SHOP_ERRORS.idempotencyKey }
    throw e
  }
}
