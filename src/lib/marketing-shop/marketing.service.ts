/**
 * Lot I Planificator V2 : service marketing (laboratoire interne). Toute lecture et écriture est bornée par
 * `ctx.companyId` (session) ; chaque écriture est auditée (HistoryLog : opération et identifiants, aucune donnée
 * personnelle libre) dans sa transaction.
 *
 * Sérialisation par client, sans état global : octroi, retrait et attribution verrouillent la MÊME ligne de consentement
 * (`marketing_consents`, clé (société, client)) en `FOR UPDATE`. Un retrait validé avant une attribution la fait refuser ;
 * une attribution validée avant un retrait reste acquise (elle a eu lieu sous consentement). Le premier octroi crée la
 * ligne : deux octrois simultanés se départagent par l'unicité (société, client). La base relit aussi le consentement
 * sous verrou partagé à l'insertion d'une conversion (déclencheur), en défense.
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { serverNow } from "@/lib/billing/clock"
import { parseDay } from "@/lib/equipment/equipment.core"
import { MARKETING_ERRORS, validateChannel, validateName } from "@/lib/marketing-shop/marketing.core"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface MarketingContext { companyId: string; userId: string }
export type MarketingResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

class MarketingFailure extends Error {
  constructor(readonly userMessage: string) { super(userMessage); this.name = "MarketingFailure" }
}
const fail = (m: string): never => { throw new MarketingFailure(m) }
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, onUnique: string = MARKETING_ERRORS.changedMeanwhile): Promise<MarketingResult<T>> {
  try {
    return { ok: true, value: await db.$transaction(fn) }
  } catch (e) {
    if (e instanceof MarketingFailure) return { ok: false, error: e.userMessage }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: onUnique }
    // Défense en base (déclencheur) : consentement retiré entre-temps.
    if (e instanceof Error && /marketing consent not granted/.test(e.message)) return { ok: false, error: MARKETING_ERRORS.consentRequired }
    throw e
  }
}
/** Journal minimal : opération et identifiants ; aucune donnée personnelle libre. */
export const MARKETING_AUDIT = {
  sourceCreated: "Source marketing créée.",
  campaignCreated: "Campagne marketing créée.",
  consentGranted: "Consentement d'attribution marketing accordé.",
  consentWithdrawn: "Consentement d'attribution marketing retiré.",
  orderAttributed: "Commande boutique attribuée à une campagne.",
} as const
async function audit(tx: Tx, ctx: MarketingContext, action: "CREATED" | "STATUS_CHANGED", entityType: string, entityId: string, detail: string) {
  await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action, entityType, entityId, detail } })
}

export async function createSource(db: Db, ctx: MarketingContext, input: { channel: string; name: string }): Promise<MarketingResult<{ id: string }>> {
  const channel = validateChannel(input.channel)
  if (!channel.ok) return channel
  const name = validateName(input.name)
  if (!name.ok) return name
  return inTx(db, async (tx) => {
    const s = await tx.marketingSource.create({ data: { companyId: ctx.companyId, channel: channel.value, name: name.value, createdById: ctx.userId }, select: { id: true } })
    await audit(tx, ctx, "CREATED", "MarketingSource", s.id, MARKETING_AUDIT.sourceCreated)
    return { id: s.id }
  }, MARKETING_ERRORS.sourceExists)
}

export async function createCampaign(db: Db, ctx: MarketingContext, input: { sourceId: string; name: string; startsOn: string; endsOn: string }): Promise<MarketingResult<{ id: string }>> {
  const name = validateName(input.name)
  if (!name.ok) return name
  const startsOn = input.startsOn === "" ? null : parseDay(input.startsOn)
  const endsOn = input.endsOn === "" ? null : parseDay(input.endsOn)
  if ((input.startsOn !== "" && !startsOn) || (input.endsOn !== "" && !endsOn) || (startsOn && endsOn && endsOn.getTime() < startsOn.getTime())) return { ok: false, error: MARKETING_ERRORS.dates }
  return inTx(db, async (tx) => {
    const src = (await tx.marketingSource.findFirst({ where: { id: input.sourceId, companyId: ctx.companyId }, select: { id: true } })) ?? fail(MARKETING_ERRORS.source)
    const c = await tx.marketingCampaign.create({ data: { companyId: ctx.companyId, sourceId: src.id, name: name.value, startsOn, endsOn, createdById: ctx.userId }, select: { id: true } })
    await audit(tx, ctx, "CREATED", "MarketingCampaign", c.id, MARKETING_AUDIT.campaignCreated)
    return { id: c.id }
  }, MARKETING_ERRORS.campaignExists)
}

/** Ligne de consentement du client verrouillée (FOR UPDATE) : point de sérialisation unique par (société, client). */
async function lockConsent(tx: Tx, ctx: MarketingContext, clientId: string) {
  const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT "id", "status"::text AS "status" FROM "marketing_consents" WHERE "companyId" = ${ctx.companyId} AND "clientId" = ${clientId} FOR UPDATE`
  return rows[0] ?? null
}
async function activeClient(tx: Tx, ctx: MarketingContext, clientId: string) {
  return (await tx.client.findFirst({ where: { id: clientId, companyId: ctx.companyId, active: true }, select: { id: true } })) ?? fail(MARKETING_ERRORS.client)
}

export async function grantConsent(db: Db, ctx: MarketingContext, clientId: string, now: Date = serverNow()): Promise<MarketingResult<{ id: string }>> {
  return inTx(db, async (tx) => {
    const client = await activeClient(tx, ctx, clientId)
    const current = await lockConsent(tx, ctx, client.id)
    let id: string
    if (!current) {
      id = (await tx.marketingConsent.create({ data: { companyId: ctx.companyId, clientId: client.id, status: "GRANTED", grantedAt: now, grantedById: ctx.userId }, select: { id: true } })).id
    } else {
      if (current.status === "GRANTED") fail(MARKETING_ERRORS.alreadyGranted)
      await tx.marketingConsent.update({ where: { id: current.id }, data: { status: "GRANTED", grantedAt: now, grantedById: ctx.userId, withdrawnAt: null, withdrawnById: null } })
      id = current.id
    }
    await audit(tx, ctx, "STATUS_CHANGED", "MarketingConsent", id, MARKETING_AUDIT.consentGranted)
    return { id }
  })
}

export async function withdrawConsent(db: Db, ctx: MarketingContext, clientId: string, now: Date = serverNow()): Promise<MarketingResult> {
  return inTx(db, async (tx) => {
    const current = await lockConsent(tx, ctx, clientId)
    if (!current || current.status !== "GRANTED") fail(MARKETING_ERRORS.notGranted)
    await tx.marketingConsent.update({ where: { id: current!.id }, data: { status: "WITHDRAWN", withdrawnAt: now, withdrawnById: ctx.userId } })
    await audit(tx, ctx, "STATUS_CHANGED", "MarketingConsent", current!.id, MARKETING_AUDIT.consentWithdrawn)
    return undefined
  })
}

/** Conversion : attribution explicite d'une commande boutique de la société à une campagne de la société. */
export async function attributeOrder(db: Db, ctx: MarketingContext, input: { orderId: string; campaignId: string }): Promise<MarketingResult<{ id: string }>> {
  return inTx(db, async (tx) => {
    const order = (await tx.shopOrder.findFirst({ where: { id: input.orderId, companyId: ctx.companyId }, select: { id: true, clientId: true, totalHTCents: true } })) ?? fail(MARKETING_ERRORS.order)
    const campaign = (await tx.marketingCampaign.findFirst({ where: { id: input.campaignId, companyId: ctx.companyId }, select: { id: true } })) ?? fail(MARKETING_ERRORS.campaign)
    // Consentement en cours vérifié sous le verrou de la ligne de consentement, dans la transaction de l'attribution.
    const consent = await lockConsent(tx, ctx, order.clientId)
    if (!consent || consent.status !== "GRANTED") fail(MARKETING_ERRORS.consentRequired)
    if (await tx.marketingConversion.findFirst({ where: { companyId: ctx.companyId, orderId: order.id }, select: { id: true } })) fail(MARKETING_ERRORS.alreadyConverted)
    const v = await tx.marketingConversion.create({
      data: { companyId: ctx.companyId, orderId: order.id, clientId: order.clientId, campaignId: campaign.id, attributedHTCents: order.totalHTCents, createdById: ctx.userId },
      select: { id: true },
    })
    await audit(tx, ctx, "CREATED", "ShopOrder", order.id, MARKETING_AUDIT.orderAttributed)
    return { id: v.id }
  }, MARKETING_ERRORS.alreadyConverted)
}
