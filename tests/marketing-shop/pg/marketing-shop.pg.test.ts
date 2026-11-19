/**
 * Lot I Planificator V2 : marketing et boutique de simulation sur une base PostgreSQL JETABLE, jeu FICTIF.
 * Calcul et arrondi, promotions (valable, inactive, pas encore valable, expirée), instantané de prix après changement de
 * l'article, idempotence (rejeu, paramètres différents, envois simultanés), consentement absent / accordé / retiré,
 * sérialisation retrait–attribution, une conversion par commande, indicateurs, isolation, références forgées refusées
 * par la base, immuabilité, aucun devis / facture / mouvement de stock écrit.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh loti_marketing_shop npm run test:marketing-shop:pg
 * Base jetable uniquement (Mac), jamais sur le VPS ni sur des données réelles.
 */
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import * as shop from "@/lib/marketing-shop/shop.service"
import * as marketing from "@/lib/marketing-shop/marketing.service"
import { getMarketingView, getOrder, sourceTotals } from "@/lib/marketing-shop/queries"
import { SHOP_ERRORS } from "@/lib/marketing-shop/shop.core"
import { MARKETING_ERRORS } from "@/lib/marketing-shop/marketing.core"

const db = new PrismaClient()
const A = { companyId: "coA", userId: "uA" }
const B = { companyId: "coB", userId: "uB" }
const T0 = new Date("2026-11-19T10:00:00Z") // jour civil de Paris : 2026-11-19
const C = (n: number) => BigInt(n)
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
let n = 0
const key = () => `cle-test-${String(++n).padStart(4, "0")}`
const order = (clientId: string, lines: [string, string][], promoCode = "", k = key()) => ({ idempotencyKey: k, clientId, lines: lines.map(([articleId, quantity]) => ({ articleId, quantity })), promoCode })
let campaign1 = "", campaign2 = "", order1 = "", order2 = ""

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','A','a',now()),('coB','B','b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uB','b@x.test','x',now())`,
    `INSERT INTO clients(id,"companyId",name,active,"updatedAt") VALUES ('clA','coA','Client fictif A',true,now()),('clA2','coA','Client fictif A2',true,now()),('clA3','coA','Client fictif A3',true,now()),('clOff','coA','Client inactif',false,now()),('clB','coB','Client fictif B',true,now())`,
    `INSERT INTO articles(id,"companyId",designation,unit,"unitPrice","vatRate",active,"updatedAt") VALUES
      ('artA1','coA','Article fictif 1','u',10.00,20,true,now()),
      ('artA2','coA','Article fictif 2','m²',3.33,5.5,true,now()),
      ('artOff','coA','Article retiré','u',1.00,20,false,now()),
      ('artB','coB','Article fictif B','u',5.00,20,true,now())`,
  ]) await db.$executeRawUnsafe(sqlText)
})
after(() => db.$disconnect())

describe("promotions", () => {
  it("création : code normalisé, unicité par société, pourcentage et fenêtre contrôlés", async () => {
    ok(await shop.createPromotion(db, A, { code: " promo-12 ", percent: "12,5", validFrom: "2026-11-01", validUntil: "2026-11-30" }))
    assert.deepEqual(await shop.createPromotion(db, A, { code: "PROMO-12", percent: "5", validFrom: "2026-11-01", validUntil: "2026-11-30" }), { ok: false, error: SHOP_ERRORS.promoExists })
    ok(await shop.createPromotion(db, B, { code: "PROMO-12", percent: "5", validFrom: "2026-11-01", validUntil: "2026-11-30" }))
    assert.deepEqual(await shop.createPromotion(db, A, { code: "BAD", percent: "0", validFrom: "2026-11-01", validUntil: "2026-11-30" }), { ok: false, error: SHOP_ERRORS.promoPercent })
    assert.deepEqual(await shop.createPromotion(db, A, { code: "BAD", percent: "5", validFrom: "2026-11-30", validUntil: "2026-11-01" }), { ok: false, error: SHOP_ERRORS.promoWindow })
    ok(await shop.createPromotion(db, A, { code: "ETE-2026", percent: "20", validFrom: "2026-06-01", validUntil: "2026-08-31" }))
    ok(await shop.createPromotion(db, A, { code: "NOEL-2026", percent: "20", validFrom: "2026-12-01", validUntil: "2026-12-31" }))
    const off = ok(await shop.createPromotion(db, A, { code: "ARRET", percent: "20", validFrom: "2026-11-01", validUntil: "2026-11-30" })).id
    ok(await shop.setPromotionActive(db, A, off, false))
    await assert.rejects(db.$executeRawUnsafe(`UPDATE shop_promotions SET "percentBp" = 5000 WHERE id = '${off}'`), /shop promotion terms immutable/)
  })
  it("commande : code expiré, pas encore valable, inactif ou inconnu refusé ; rien n'est créé", async () => {
    assert.deepEqual(await shop.createOrder(db, A, order("clA", [["artA1", "1"]], "ete-2026"), T0), { ok: false, error: SHOP_ERRORS.promoExpired })
    assert.deepEqual(await shop.createOrder(db, A, order("clA", [["artA1", "1"]], "NOEL-2026"), T0), { ok: false, error: SHOP_ERRORS.promoNotYet })
    assert.deepEqual(await shop.createOrder(db, A, order("clA", [["artA1", "1"]], "ARRET"), T0), { ok: false, error: SHOP_ERRORS.promoInactive })
    assert.deepEqual(await shop.createOrder(db, A, order("clA", [["artA1", "1"]], "INCONNU"), T0), { ok: false, error: SHOP_ERRORS.promoUnknown })
    assert.equal(await db.shopOrder.count(), 0)
  })
})

describe("commandes de simulation", () => {
  it("calcul et arrondi : remise 12,5 % par ligne sur le HT, TVA par ligne après remise ; lignes et promotion figées", async () => {
    order1 = ok(await shop.createOrder(db, A, order("clA", [["artA1", "3"], ["artA2", "1"]], "promo-12"), T0)).id
    const o = (await getOrder(db, "coA", order1))!
    assert.deepEqual([o.subtotalCents, o.discountCents, o.totalHTCents, o.totalVATCents, o.totalTTCCents], [C(3333), C(417), C(2916), C(541), C(3457)])
    assert.deepEqual([o.promotionCode, o.promotionPercentBp], ["PROMO-12", 1250])
    assert.deepEqual(o.lines.map((l) => [l.position, l.designation, l.unit, l.quantity, l.unitPriceCents, l.vatRateBp, l.grossCents, l.discountCents, l.netCents, l.vatCents]), [
      [1, "Article fictif 1", "u", 3, C(1000), 2000, C(3000), C(375), C(2625), C(525)],
      [2, "Article fictif 2", "m²", 1, C(333), 550, C(333), C(42), C(291), C(16)],
    ])
  })
  it("instantané : un changement de l'article ne modifie pas la commande ; une nouvelle commande prend le nouveau prix", async () => {
    await db.$executeRawUnsafe(`UPDATE articles SET "unitPrice" = 99.99, designation = 'Article renommé', "vatRate" = 10 WHERE id = 'artA1'`)
    const o = (await getOrder(db, "coA", order1))!
    assert.deepEqual([o.lines[0].designation, o.lines[0].unitPriceCents, o.lines[0].vatRateBp, o.totalHTCents], ["Article fictif 1", C(1000), 2000, C(2916)])
    order2 = ok(await shop.createOrder(db, A, order("clA2", [["artA1", "1"]]), T0)).id
    const o2 = (await getOrder(db, "coA", order2))!
    assert.deepEqual([o2.lines[0].designation, o2.lines[0].unitPriceCents, o2.lines[0].vatRateBp, o2.totalHTCents, o2.totalVATCents, o2.promotionCode], ["Article renommé", C(9999), 1000, C(9999), C(1000), null])
  })
  it("refus : client inactif ou d'une autre société, article inactif ou d'une autre société, quantité hors bornes ; prix jamais lus du formulaire", async () => {
    assert.deepEqual(await shop.createOrder(db, A, order("clOff", [["artA1", "1"]]), T0), { ok: false, error: SHOP_ERRORS.client })
    assert.deepEqual(await shop.createOrder(db, A, order("clB", [["artA1", "1"]]), T0), { ok: false, error: SHOP_ERRORS.client })
    assert.deepEqual(await shop.createOrder(db, A, order("clA", [["artOff", "1"]]), T0), { ok: false, error: SHOP_ERRORS.article })
    assert.deepEqual(await shop.createOrder(db, A, order("clA", [["artB", "1"]]), T0), { ok: false, error: SHOP_ERRORS.article })
    assert.deepEqual(await shop.createOrder(db, A, order("clA", [["artA1", "1000"]]), T0), { ok: false, error: SHOP_ERRORS.quantity })
    assert.deepEqual(await shop.createOrder(db, A, order("clA", [["artA1", "1"]], "", "court"), T0), { ok: false, error: SHOP_ERRORS.idempotencyKey })
  })
  it("idempotence : rejeu identique sans doublon ; mêmes clé et autres paramètres refusés ; envois simultanés départagés", async () => {
    const k = key()
    const first = ok(await shop.createOrder(db, A, order("clA3", [["artA2", "2"]], "", k), T0))
    assert.deepEqual(await shop.createOrder(db, A, order("clA3", [["artA2", "2"]], "", k), T0), { ok: true, value: { id: first.id, replayed: true } })
    assert.deepEqual(await shop.createOrder(db, A, order("clA3", [["artA2", "3"]], "", k), T0), { ok: false, error: SHOP_ERRORS.idempotencyMismatch })
    assert.equal(await db.shopOrder.count({ where: { companyId: "coA", idempotencyKey: k } }), 1)
    const k2 = key()
    const rs = await Promise.all([1, 2, 3, 4].map(() => shop.createOrder(db, A, order("clA3", [["artA1", "1"]], "", k2), T0)))
    const ids = rs.map((r) => ok(r).id)
    assert.equal(new Set(ids).size, 1, "une seule commande pour quatre envois simultanés")
    assert.equal(rs.filter((r) => r.ok && !r.value.replayed).length, 1)
    assert.equal(await db.shopOrder.count({ where: { companyId: "coA", idempotencyKey: k2 } }), 1)
    // Même clé dans une autre société : clé idempotente par société, commande distincte.
    ok(await shop.createOrder(db, B, order("clB", [["artB", "1"]], "", k2), T0))
  })
  it("commandes et lignes immuables ; totaux incohérents refusés par la base à la validation", async () => {
    await assert.rejects(db.$executeRawUnsafe(`UPDATE shop_orders SET "totalHTCents" = 1 WHERE id = '${order1}'`), /append-only/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM shop_order_lines WHERE "orderId" = '${order1}'`), /append-only/)
    // v3 : Prisma 5.22 ne remonte pas toujours un rejet levé à la VALIDATION d'une transaction. Le contrôle différé est donc
    // forcé dans le corps de chaque transaction de test, après les écritures intentionnellement incohérentes, par la même
    // instruction constante que le service (`createOrder`). L'absence persistée est vérifiée après chaque rejet.
    const forcer = (tx: { $executeRawUnsafe: (sql: string) => Promise<number> }) => tx.$executeRawUnsafe(`SET CONSTRAINTS shop_orders_totals_guard, shop_order_lines_totals_guard IMMEDIATE`)
    /** Ligne forgée, quantité 1 : [prix HT, taux en points de base, brut, remise, net, TVA] en centimes. */
    const ligne = (id: string, orderId: string, position: number, m: [number, number, number, number, number, number]) =>
      `INSERT INTO shop_order_lines(id,"companyId","orderId",position,"articleId",designation,unit,quantity,"unitPriceCents","vatRateBp","grossCents","discountCents","netCents","vatCents") VALUES ('${id}','coA','${orderId}',${position},'artA2','Ligne forgée','u',1,${m.join(",")})`
    const commande = (id: string, cle: string, sha: string, lineCount: number, t: [number, number, number, number, number]) =>
      `INSERT INTO shop_orders(id,"companyId","idempotencyKey","requestSha256","clientId","promotionPercentBp","lineCount","subtotalCents","discountCents","totalHTCents","totalVATCents","totalTTCCents","createdById") VALUES ('${id}','coA','${cle}','${sha.repeat(64)}','clA',0,${lineCount},${t[0]},${t[1]},${t[2]},${t[3]},${t[4]},'uA')`
    // 1. Commande forgée : une ligne, totaux incohérents ⇒ rejet dans la transaction ; ni la commande ni la ligne ne restent.
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(commande("ox", "cle-forgee-01", "a", 1, [1000, 0, 1000, 200, 1200]))
      await tx.$executeRawUnsafe(ligne("lx", "ox", 1, [999, 2000, 999, 0, 999, 200]))
      await forcer(tx)
    }), /shop order totals mismatch/)
    assert.equal(await db.shopOrder.count({ where: { id: "ox" } }), 0)
    assert.equal(await db.shopOrderLine.count({ where: { id: "lx" } }), 0)
    // 2. Ligne tardive PAYANTE ajoutée à une commande enregistrée (2 lignes) ⇒ rejet ; absente ensuite.
    assert.equal((await db.shopOrder.findUniqueOrThrow({ where: { id: order1 }, select: { lineCount: true } })).lineCount, 2)
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(ligne("ly", order1, 3, [333, 550, 333, 0, 333, 18]))
      await forcer(tx)
    }), /shop order line count mismatch/)
    assert.equal(await db.shopOrderLine.count({ where: { id: "ly" } }), 0)
    // 3. Ligne tardive GRATUITE : elle ne change aucune somme ; le nombre de lignes figé la fait refuser ; absente ensuite.
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(ligne("lfree", order1, 4, [0, 550, 0, 0, 0, 0]))
      await forcer(tx)
    }), /shop order line count mismatch/)
    assert.equal(await db.shopOrderLine.count({ where: { id: "lfree" } }), 0)
    const kept = (await getOrder(db, "coA", order1))!
    assert.deepEqual([kept.lines.length, kept.totalHTCents, kept.totalTTCCents], [2, C(2916), C(3457)], "la commande garde ses deux lignes et ses totaux")
    // 4. Nombre de lignes enregistré différent du nombre réel (sommes justes) ⇒ rejet ; rien ne reste.
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(commande("ow", "cle-forgee-04", "d", 2, [333, 0, 333, 18, 351]))
      await tx.$executeRawUnsafe(ligne("lw", "ow", 1, [333, 550, 333, 0, 333, 18]))
      await forcer(tx)
    }), /shop order line count mismatch/)
    assert.equal(await db.shopOrder.count({ where: { id: "ow" } }), 0)
    assert.equal(await db.shopOrderLine.count({ where: { id: "lw" } }), 0)
    // 5. Nombre de lignes hors bornes : refusé immédiatement par le CHECK.
    await assert.rejects(db.$executeRawUnsafe(commande("ov", "cle-forgee-05", "e", 21, [0, 0, 0, 0, 0])), /shop_orders_values_check/)
    assert.equal(await db.shopOrder.count({ where: { id: "ov" } }), 0)
  })
})

describe("consentement et conversions", () => {
  it("sources et campagnes : canal fermé, nom unique, campagne liée à une source de la société", async () => {
    const s = ok(await marketing.createSource(db, A, { channel: "EVENT", name: "Salon fictif" })).id
    assert.deepEqual(await marketing.createSource(db, A, { channel: "EVENT", name: "Salon fictif" }), { ok: false, error: MARKETING_ERRORS.sourceExists })
    assert.deepEqual(await marketing.createSource(db, A, { channel: "PIXEL", name: "Autre" }), { ok: false, error: MARKETING_ERRORS.channel })
    const sB = ok(await marketing.createSource(db, B, { channel: "WEBSITE", name: "Site B" })).id
    campaign1 = ok(await marketing.createCampaign(db, A, { sourceId: s, name: "Campagne fictive 1", startsOn: "2026-11-01", endsOn: "2026-11-30" })).id
    campaign2 = ok(await marketing.createCampaign(db, A, { sourceId: s, name: "Campagne fictive 2", startsOn: "", endsOn: "" })).id
    assert.deepEqual(await marketing.createCampaign(db, A, { sourceId: sB, name: "Forgée", startsOn: "", endsOn: "" }), { ok: false, error: MARKETING_ERRORS.source })
    assert.deepEqual(await marketing.createCampaign(db, A, { sourceId: s, name: "Dates", startsOn: "2026-11-30", endsOn: "2026-11-01" }), { ok: false, error: MARKETING_ERRORS.dates })
  })
  it("consentement absent : attribution refusée ; la commande ordinaire existe sans consentement", async () => {
    assert.deepEqual(await marketing.attributeOrder(db, A, { orderId: order1, campaignId: campaign1 }), { ok: false, error: MARKETING_ERRORS.consentRequired })
    assert.equal(await db.marketingConsent.count({ where: { clientId: "clA" } }), 0, "aucun consentement par défaut")
    assert.ok(await getOrder(db, "coA", order1))
  })
  it("consentement accordé : attribution ; une seule conversion par commande ; montant = total HT net figé", async () => {
    ok(await marketing.grantConsent(db, A, "clA", T0))
    assert.deepEqual(await marketing.grantConsent(db, A, "clA", T0), { ok: false, error: MARKETING_ERRORS.alreadyGranted })
    const c = await db.marketingConsent.findFirstOrThrow({ where: { companyId: "coA", clientId: "clA" }, select: { status: true, grantedAt: true, grantedById: true, withdrawnAt: true } })
    assert.deepEqual([c.status, c.grantedAt.toISOString(), c.grantedById, c.withdrawnAt], ["GRANTED", T0.toISOString(), "uA", null])
    ok(await marketing.attributeOrder(db, A, { orderId: order1, campaignId: campaign1 }))
    assert.deepEqual(await marketing.attributeOrder(db, A, { orderId: order1, campaignId: campaign2 }), { ok: false, error: MARKETING_ERRORS.alreadyConverted })
    const v = await db.marketingConversion.findFirstOrThrow({ where: { orderId: order1 }, select: { attributedHTCents: true, clientId: true } })
    assert.deepEqual([v.attributedHTCents, v.clientId], [C(2916), "clA"])
  })
  it("consentement retiré : nouvelle attribution refusée (service et base) ; réoctroi possible ; octroi et retrait tracés", async () => {
    const o3 = ok(await shop.createOrder(db, A, order("clA", [["artA2", "1"]]), T0)).id
    ok(await marketing.withdrawConsent(db, A, "clA", T0))
    assert.deepEqual(await marketing.withdrawConsent(db, A, "clA", T0), { ok: false, error: MARKETING_ERRORS.notGranted })
    assert.deepEqual(await marketing.attributeOrder(db, A, { orderId: o3, campaignId: campaign1 }), { ok: false, error: MARKETING_ERRORS.consentRequired })
    const total = (await db.shopOrder.findUniqueOrThrow({ where: { id: o3 }, select: { totalHTCents: true } })).totalHTCents
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO marketing_conversions(id,"companyId","orderId","clientId","campaignId","attributedHTCents","createdById") VALUES ('cvx','coA','${o3}','clA','${campaign1}',${total.toString()},'uA')`), /marketing consent not granted/)
    const w = await db.marketingConsent.findFirstOrThrow({ where: { companyId: "coA", clientId: "clA" }, select: { status: true, withdrawnAt: true, withdrawnById: true } })
    assert.deepEqual([w.status, w.withdrawnById, !!w.withdrawnAt], ["WITHDRAWN", "uA", true])
    ok(await marketing.grantConsent(db, A, "clA", T0))
    ok(await marketing.attributeOrder(db, A, { orderId: o3, campaignId: campaign2 }))
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM marketing_consents WHERE "clientId" = 'clA'`), /cannot be deleted/)
    const logs = await db.historyLog.findMany({ where: { companyId: "coA", entityType: "MarketingConsent" }, select: { detail: true, actorId: true } })
    assert.deepEqual(logs.map((l) => l.detail).sort(), [marketing.MARKETING_AUDIT.consentGranted, marketing.MARKETING_AUDIT.consentGranted, marketing.MARKETING_AUDIT.consentWithdrawn].sort())
    assert.ok(logs.every((l) => l.actorId === "uA" && !/Client fictif/.test(l.detail ?? "")), "journal sans nom de client")
  })
  it("sérialisation : un retrait validé pendant que l'attribution attend le verrou la fait refuser", async () => {
    ok(await marketing.grantConsent(db, A, "clA2", T0))
    const course: { attribution?: ReturnType<typeof marketing.attributeOrder> } = {}
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "marketing_consents" WHERE "companyId" = 'coA' AND "clientId" = 'clA2' FOR UPDATE`
      await tx.$executeRaw`UPDATE "marketing_consents" SET "status" = 'WITHDRAWN', "withdrawnAt" = CURRENT_TIMESTAMP, "withdrawnById" = 'uA' WHERE "companyId" = 'coA' AND "clientId" = 'clA2'`
      course.attribution = marketing.attributeOrder(db, A, { orderId: order2, campaignId: campaign1 })
      await new Promise((r) => setTimeout(r, 500))
    }, { timeout: 15_000 })
    assert.ok(course.attribution)
    assert.deepEqual(await course.attribution, { ok: false, error: MARKETING_ERRORS.consentRequired })
    assert.equal(await db.marketingConversion.count({ where: { orderId: order2 } }), 0)
  })
  it("retrait et attribution simultanés : jamais de conversion postérieure au retrait validé", async () => {
    ok(await marketing.grantConsent(db, A, "clA2", T0))
    const [w, attr] = await Promise.all([marketing.withdrawConsent(db, A, "clA2", T0), marketing.attributeOrder(db, A, { orderId: order2, campaignId: campaign1 })])
    assert.ok(w.ok)
    const conv = await db.marketingConversion.count({ where: { orderId: order2 } })
    if (attr.ok) assert.equal(conv, 1, "attribution validée avant le retrait : acquise")
    else { assert.deepEqual(attr, { ok: false, error: MARKETING_ERRORS.consentRequired }); assert.equal(conv, 0) }
  })
  it("indicateurs : commandes converties et montant HT net attribué par campagne et par source", async () => {
    const v = await getMarketingView(db, "coA")
    const byId = Object.fromEntries(v.indicators.campaigns.map((k) => [k.campaignId, k]))
    const o3total = (await db.marketingConversion.findFirstOrThrow({ where: { campaignId: campaign2 }, select: { attributedHTCents: true } })).attributedHTCents
    const c1 = await db.marketingConversion.aggregate({ where: { campaignId: campaign1 }, _count: { _all: true }, _sum: { attributedHTCents: true } })
    assert.deepEqual([byId[campaign1].convertedOrders, byId[campaign1].attributedHTCents], [c1._count._all, c1._sum.attributedHTCents ?? C(0)])
    assert.deepEqual([byId[campaign2].convertedOrders, byId[campaign2].attributedHTCents], [1, o3total])
    const src = v.indicators.sources.find((s) => s.name === "Salon fictif")!
    assert.equal(src.convertedOrders, byId[campaign1].convertedOrders + 1)
    assert.equal(src.attributedHTCents, byId[campaign1].attributedHTCents + o3total)
  })
  it("v2 de revue : totaux par source indépendants des 500 campagnes affichées ; nom réel de la source hors des 200 listées", async () => {
    const s = (await db.marketingSource.findFirstOrThrow({ where: { companyId: "coA", name: "Salon fictif" }, select: { id: true } })).id
    const attendu = await db.marketingConversion.aggregate({ where: { companyId: "coA", campaign: { sourceId: s } }, _count: { _all: true }, _sum: { attributedHTCents: true } })
    assert.ok(attendu._count._all >= 2, "conversions de la source réparties sur campagne fictive 1 et 2")
    // 500 campagnes de la même source, triées AVANT les campagnes fictives : celles-ci sortent de la liste affichée.
    await db.$executeRawUnsafe(`INSERT INTO marketing_campaigns(id,"companyId","sourceId",name,"createdById") SELECT 'kbulk' || g, 'coA', '${s}', 'AAA campagne ' || lpad(g::text, 3, '0'), 'uA' FROM generate_series(1, 500) g`)
    const v = await getMarketingView(db, "coA")
    assert.equal(v.campaigns.length, 500, "limite d'affichage des campagnes conservée")
    assert.ok(!v.campaigns.some((c) => c.id === campaign1 || c.id === campaign2), "campagnes converties hors de la liste affichée")
    assert.ok(v.indicators.campaigns.every((k) => k.convertedOrders === 0), "lignes par campagne : seules les campagnes affichées")
    const src = v.indicators.sources.find((x) => x.sourceId === s)!
    assert.deepEqual([src.convertedOrders, src.attributedHTCents], [attendu._count._all, attendu._sum.attributedHTCents ?? C(0)], "total de la source sur TOUTES ses campagnes")
    // 200 sources triées AVANT « Salon fictif » : elle sort de la liste des sources ; ses campagnes affichées gardent son nom.
    await db.$executeRawUnsafe(`INSERT INTO marketing_sources(id,"companyId",channel,name,"createdById") SELECT 'sbulk' || g, 'coA', 'OTHER', 'AAA source ' || lpad(g::text, 3, '0'), 'uA' FROM generate_series(1, 200) g`)
    const v2 = await getMarketingView(db, "coA")
    assert.equal(v2.sources.length, 200)
    assert.ok(!v2.sources.some((x) => x.id === s))
    assert.ok(v2.campaigns.filter((c) => c.sourceId === s).every((c) => c.source.name === "Salon fictif"), "nom réel de la source")
    const totaux = await sourceTotals(db, "coA")
    assert.deepEqual(totaux.find((t) => t.sourceId === s), { sourceId: s, convertedOrders: attendu._count._all, attributedHTCents: attendu._sum.attributedHTCents ?? C(0) })
    assert.deepEqual(await sourceTotals(db, "coB"), [], "aucune conversion d'une autre société comptée")
  })
})

describe("isolation, références forgées et périmètre", () => {
  it("une autre société ne lit ni n'attribue ; références croisées refusées par la base", async () => {
    assert.equal(await getOrder(db, "coB", order1), null)
    assert.deepEqual(await marketing.attributeOrder(db, B, { orderId: order1, campaignId: campaign1 }), { ok: false, error: MARKETING_ERRORS.order })
    assert.deepEqual(await marketing.grantConsent(db, B, "clA", T0), { ok: false, error: MARKETING_ERRORS.client })
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO marketing_consents(id,"companyId","clientId",status,"grantedAt","grantedById","updatedAt") VALUES ('mcx','coB','clA','GRANTED',now(),'uB',now())`), /marketing_consents_clientId_companyId_fkey|foreign key/i)
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO shop_orders(id,"companyId","idempotencyKey","requestSha256","clientId","promotionPercentBp","lineCount","subtotalCents","discountCents","totalHTCents","totalVATCents","totalTTCCents","createdById") VALUES ('oy','coB','cle-forgee-02','${"b".repeat(64)}','clA',0,1,500,0,500,100,600,'uB')`)
    }), /shop_orders_clientId_companyId_fkey|foreign key/i)
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO shop_orders(id,"companyId","idempotencyKey","requestSha256","clientId","promotionPercentBp","lineCount","subtotalCents","discountCents","totalHTCents","totalVATCents","totalTTCCents","createdById") VALUES ('oz','coB','cle-forgee-03','${"c".repeat(64)}','clB',0,1,500,0,500,100,600,'uB')`)
      await tx.$executeRawUnsafe(`INSERT INTO shop_order_lines(id,"companyId","orderId",position,"articleId",designation,unit,quantity,"unitPriceCents","vatRateBp","grossCents","discountCents","netCents","vatCents") VALUES ('lz','coB','oz',1,'artA1','Article forgé','u',1,500,2000,500,0,500,100)`)
    }), /shop_order_lines_companyId_articleId_fkey|foreign key/i)
    // Montant égal au total de la commande et consentement de clA accordé : seul le couple (commande, client) est faux.
    const o4 = ok(await shop.createOrder(db, A, order("clA3", [["artA2", "4"]]), T0)).id
    const o4total = (await db.shopOrder.findUniqueOrThrow({ where: { id: o4 }, select: { totalHTCents: true } })).totalHTCents
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO marketing_conversions(id,"companyId","orderId","clientId","campaignId","attributedHTCents","createdById") VALUES ('cvy','coA','${o4}','clA','${campaign1}',${o4total.toString()},'uA')`), /marketing_conversions_companyId_orderId_clientId_fkey|foreign key/i, "client différent de celui de la commande")
  })
  it("aucun devis, aucune facture, aucun mouvement de stock écrit ; journal des commandes sans donnée personnelle", async () => {
    assert.deepEqual([await db.quote.count(), await db.invoice.count(), await db.stockMovement.count()], [0, 0, 0])
    const logs = await db.historyLog.findMany({ where: { companyId: "coA", entityType: { in: ["ShopOrder", "ShopPromotion", "MarketingSource", "MarketingCampaign"] } }, select: { detail: true } })
    assert.ok(logs.length > 0)
    for (const l of logs) assert.doesNotMatch(l.detail ?? "", /Client fictif|Article fictif|PROMO-12|€|\d{2,}/, l.detail ?? "")
  })
})
