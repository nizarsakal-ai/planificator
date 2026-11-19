/** Lot I Planificator V2 : lectures du marketing et de la boutique, toutes bornées par `companyId`. Lecture seule : aucune
 * écriture, aucun devis ni facture lu ou écrit. */
import type { PrismaClient } from "@prisma/client"
import { computeIndicators, type MarketingChannel, type SourceConversionFact } from "@/lib/marketing-shop/marketing.core"

type Db = PrismaClient

/** Écran Marketing : sources, campagnes, indicateurs (agrégés en base, sommes exactes), consentements, attributions. */
export async function getMarketingView(db: Db, companyId: string) {
  const [sources, campaigns, sums, sourceSums, clients, consents, conversions, openOrders] = await Promise.all([
    db.marketingSource.findMany({ where: { companyId }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 200, select: { id: true, name: true, channel: true } }),
    // v2 de revue : nom réel de la source de chaque campagne affichée, même hors des 200 sources listées.
    db.marketingCampaign.findMany({ where: { companyId }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 500, select: { id: true, name: true, sourceId: true, startsOn: true, endsOn: true, source: { select: { name: true } } } }),
    db.marketingConversion.groupBy({ by: ["campaignId"], where: { companyId }, _count: { _all: true }, _sum: { attributedHTCents: true } }),
    sourceTotals(db, companyId),
    db.client.findMany({ where: { companyId, active: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 200, select: { id: true, name: true } }),
    db.marketingConsent.findMany({ where: { companyId }, select: { clientId: true, status: true, grantedAt: true, withdrawnAt: true } }),
    db.marketingConversion.findMany({ where: { companyId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, orderId: true, campaignId: true, attributedHTCents: true, createdAt: true, campaign: { select: { name: true } } } }),
    db.shopOrder.findMany({ where: { companyId, conversions: { none: {} } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 200, select: { id: true, createdAt: true, totalHTCents: true, client: { select: { name: true } } } }),
  ])
  // Indicateurs : une conversion par commande (unicité en base) ; montant = total HT net figé à l'attribution.
  const indicators = computeIndicators(
    sources.map((s) => ({ id: s.id, name: s.name, channel: s.channel as MarketingChannel })),
    campaigns.map((c) => ({ id: c.id, name: c.name, sourceId: c.sourceId })),
    sums.map((s) => ({ campaignId: s.campaignId, convertedOrders: s._count._all, attributedHTCents: s._sum.attributedHTCents ?? BigInt(0) })),
    sourceSums,
  )
  return { sources, campaigns, indicators, clients, consents: new Map(consents.map((c) => [c.clientId, c])), conversions, openOrders }
}

/**
 * v2 de revue : totaux par source calculés EN BASE sur toutes les conversions de la société (toutes campagnes, sans
 * dépendre de la liste affichée). Jointures filtrées explicitement par l'identifiant de société de chaque table.
 * Montants en BIGINT (somme convertie en bigint, aucun flottant).
 */
export async function sourceTotals(db: Db, companyId: string): Promise<SourceConversionFact[]> {
  const rows = await db.$queryRaw<{ sourceId: string; convertedOrders: number; attributedHTCents: bigint }[]>`
    SELECT k."sourceId" AS "sourceId", COUNT(c."id")::int AS "convertedOrders", COALESCE(SUM(c."attributedHTCents"), 0)::bigint AS "attributedHTCents"
    FROM "marketing_conversions" c
    JOIN "marketing_campaigns" k ON k."id" = c."campaignId" AND k."companyId" = c."companyId" AND k."companyId" = ${companyId}
    WHERE c."companyId" = ${companyId}
    GROUP BY k."sourceId"`
  return rows.map((r) => ({ sourceId: r.sourceId, convertedOrders: Number(r.convertedOrders), attributedHTCents: BigInt(r.attributedHTCents) }))
}

/** Écran Boutique : promotions, commandes récentes et listes de choix (clients et articles actifs de la société). */
export async function getShopView(db: Db, companyId: string) {
  const [promotions, orders, clients, articles] = await Promise.all([
    db.shopPromotion.findMany({ where: { companyId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, code: true, percentBp: true, active: true, validFrom: true, validUntil: true } }),
    db.shopOrder.findMany({
      where: { companyId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50,
      select: { id: true, createdAt: true, promotionCode: true, totalHTCents: true, totalTTCCents: true, client: { select: { name: true } }, _count: { select: { lines: true } } },
    }),
    db.client.findMany({ where: { companyId, active: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 500, select: { id: true, name: true } }),
    db.article.findMany({ where: { companyId, active: true }, orderBy: [{ designation: "asc" }, { id: "asc" }], take: 500, select: { id: true, designation: true, unit: true, unitPrice: true, vatRate: true } }),
  ])
  return { promotions, orders, clients, articles }
}

/** Fiche d'une commande : lignes et totaux FIGÉS, promotion figée, attribution éventuelle. */
export async function getOrder(db: Db, companyId: string, id: string) {
  return db.shopOrder.findFirst({
    where: { id, companyId },
    select: {
      id: true, createdAt: true, promotionCode: true, promotionPercentBp: true, subtotalCents: true, discountCents: true, totalHTCents: true, totalVATCents: true, totalTTCCents: true,
      client: { select: { name: true } },
      lines: { orderBy: { position: "asc" }, select: { position: true, designation: true, unit: true, quantity: true, unitPriceCents: true, vatRateBp: true, grossCents: true, discountCents: true, netCents: true, vatCents: true } },
      conversions: { select: { createdAt: true, attributedHTCents: true, campaign: { select: { name: true } } } },
    },
  })
}
