/**
 * Lot I Planificator V2 : règles pures du marketing et de la boutique de simulation (aucune base).
 * Calcul et arrondi au centime (remise HT par ligne, TVA par ligne après remise, demi supérieur), codes promotionnels,
 * fenêtre de validité, quantités, requête normalisée et empreinte idempotente, indicateurs sans taux, drapeau.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  MAX_ORDER_LINES, SHOP_ERRORS, computeOrder, normalizePromoCode, parsePromoPercent, parseQuantity, promotionState, requestSha256, validateOrderRequest, type PricedLine,
} from "@/lib/marketing-shop/shop.core"
import { CHANNELS, MARKETING_ERRORS, computeIndicators, validateChannel, validateName } from "@/lib/marketing-shop/marketing.core"
import { isMarketingShopEnabled } from "@/lib/marketing-shop/marketing-shop-feature-flag"

const D = (s: string) => new Date(`${s}T00:00:00Z`)
const C = (n: number) => BigInt(n)
const line = (p: Partial<PricedLine>): PricedLine => ({ articleId: "a", designation: "Article", unit: "u", quantity: 1, unitPriceCents: C(0), vatRateBp: 2000, ...p })

describe("calcul et arrondi au centime", () => {
  it("remise de commande 12,5 % répartie ligne par ligne sur le HT, TVA par ligne après remise, demi supérieur", () => {
    const o = computeOrder([
      line({ articleId: "A", quantity: 3, unitPriceCents: C(1000), vatRateBp: 2000 }),
      line({ articleId: "B", quantity: 1, unitPriceCents: C(333), vatRateBp: 550 }),
    ], 1250)
    // A : brut 30,00 ; remise 3,75 ; net 26,25 ; TVA 20 % = 5,25. B : brut 3,33 ; remise 0,41625 → 0,42 ; net 2,91 ; TVA 5,5 % = 0,16005 → 0,16.
    assert.deepEqual(o.lines.map((l) => [l.position, l.grossCents, l.discountCents, l.netCents, l.vatCents]), [[1, C(3000), C(375), C(2625), C(525)], [2, C(333), C(42), C(291), C(16)]])
    assert.deepEqual([o.subtotalCents, o.discountCents, o.totalHTCents, o.totalVATCents, o.totalTTCCents], [C(3333), C(417), C(2916), C(541), C(3457)])
  })
  it("sans promotion : totaux = sommes des lignes ; TVA d'un demi-centime arrondie au centime supérieur", () => {
    const o = computeOrder([line({ quantity: 1, unitPriceCents: C(5), vatRateBp: 1000 }), line({ quantity: 999, unitPriceCents: C(1), vatRateBp: 0 })], 0)
    assert.deepEqual(o.lines.map((l) => [l.grossCents, l.discountCents, l.vatCents]), [[C(5), C(0), C(1)], [C(999), C(0), C(0)]])
    assert.deepEqual([o.totalHTCents, o.totalVATCents, o.totalTTCCents], [C(1004), C(1), C(1005)])
  })
  it("brut exact (quantité entière × prix) ; promotion de 100 % ⇒ total nul ; invariants net = brut − remise", () => {
    const o = computeOrder([line({ quantity: 7, unitPriceCents: C(1999), vatRateBp: 2000 })], 10000)
    assert.deepEqual([o.lines[0].grossCents, o.lines[0].netCents, o.totalHTCents, o.totalVATCents], [C(13993), C(0), C(0), C(0)])
    const p = computeOrder([line({ quantity: 2, unitPriceCents: C(1234), vatRateBp: 2000 }), line({ quantity: 5, unitPriceCents: C(99), vatRateBp: 1000 })], 333)
    for (const l of p.lines) assert.equal(l.netCents, l.grossCents - l.discountCents)
    assert.equal(p.totalHTCents, p.subtotalCents - p.discountCents)
    assert.equal(p.totalTTCCents, p.totalHTCents + p.totalVATCents)
  })
})

describe("promotions", () => {
  it("code normalisé (majuscules, bords), format borné", () => {
    assert.deepEqual(normalizePromoCode("  printemps-10 "), { ok: true, value: "PRINTEMPS-10" })
    for (const bad of ["ab", "-ABC", "ÉTÉ10", "A B C", "x".repeat(33), ""]) assert.deepEqual(normalizePromoCode(bad), { ok: false, error: SHOP_ERRORS.promoFormat }, bad)
  })
  it("pourcentage de 0,01 à 100", () => {
    assert.deepEqual(parsePromoPercent("12,5"), { ok: true, value: 1250 })
    assert.deepEqual(parsePromoPercent("100"), { ok: true, value: 10000 })
    for (const bad of ["0", "", "100,01", "-5", "abc", "1,234"]) assert.deepEqual(parsePromoPercent(bad), { ok: false, error: SHOP_ERRORS.promoPercent }, bad)
  })
  it("fenêtre en jours civils, bornes incluses ; inactive, pas encore valable, expirée", () => {
    const p = { active: true, validFrom: D("2026-11-10"), validUntil: D("2026-11-20") }
    assert.equal(promotionState(p, D("2026-11-10")), "VALID")
    assert.equal(promotionState(p, D("2026-11-20")), "VALID")
    assert.equal(promotionState(p, D("2026-11-09")), "NOT_YET")
    assert.equal(promotionState(p, D("2026-11-21")), "EXPIRED")
    assert.equal(promotionState({ ...p, active: false }, D("2026-11-15")), "INACTIVE")
  })
})

describe("requête de commande", () => {
  it("quantités entières de 1 à 999, chiffres seulement", () => {
    assert.deepEqual(parseQuantity(" 12 "), { ok: true, value: 12 })
    for (const bad of ["0", "1000", "1.5", "1,5", "-1", "", "1e2", "abc"]) assert.deepEqual(parseQuantity(bad), { ok: false, error: SHOP_ERRORS.quantity }, bad)
  })
  it("lignes vides ignorées ; au moins une ligne ; au plus 20 ; article et quantité contrôlés ; code facultatif normalisé", () => {
    const r = validateOrderRequest({ clientId: "c1", lines: [{ articleId: "a1", quantity: "2" }, { articleId: "", quantity: "" }, { articleId: "a2", quantity: "1" }], promoCode: " promo-12 " })
    assert.deepEqual(r, { ok: true, value: { clientId: "c1", lines: [{ articleId: "a1", quantity: 2 }, { articleId: "a2", quantity: 1 }], promoCode: "PROMO-12" } })
    assert.deepEqual(validateOrderRequest({ clientId: "c1", lines: [{ articleId: "", quantity: "" }], promoCode: "" }), { ok: false, error: SHOP_ERRORS.noLine })
    assert.deepEqual(validateOrderRequest({ clientId: "c1", lines: [{ articleId: "a1", quantity: "" }], promoCode: "" }), { ok: false, error: SHOP_ERRORS.quantity })
    assert.deepEqual(validateOrderRequest({ clientId: "", lines: [{ articleId: "a1", quantity: "1" }], promoCode: "" }), { ok: false, error: SHOP_ERRORS.client })
    assert.deepEqual(validateOrderRequest({ clientId: "c1", lines: Array.from({ length: MAX_ORDER_LINES + 1 }, () => ({ articleId: "a1", quantity: "1" })), promoCode: "" }), { ok: false, error: SHOP_ERRORS.tooManyLines })
  })
  it("empreinte : stable pour les mêmes paramètres, différente si un paramètre change", () => {
    const base = { clientId: "c1", lines: [{ articleId: "a1", quantity: 2 }], promoCode: null }
    assert.match(requestSha256(base), /^[0-9a-f]{64}$/)
    assert.equal(requestSha256(base), requestSha256({ ...base, lines: [{ articleId: "a1", quantity: 2 }] }))
    for (const other of [{ ...base, clientId: "c2" }, { ...base, lines: [{ articleId: "a1", quantity: 3 }] }, { ...base, promoCode: "PROMO-12" }]) assert.notEqual(requestSha256(other), requestSha256(base))
  })
})

describe("marketing : canaux, noms, indicateurs, drapeau", () => {
  it("canal de la liste fermée ; nom 2 à 120 caractères", () => {
    assert.equal(CHANNELS.length, 8)
    assert.deepEqual(validateChannel("WEBSITE"), { ok: true, value: "WEBSITE" })
    assert.deepEqual(validateChannel("PIXEL"), { ok: false, error: MARKETING_ERRORS.channel })
    assert.deepEqual(validateName("  Salon de l'habitat "), { ok: true, value: "Salon de l'habitat" })
    assert.deepEqual(validateName("x"), { ok: false, error: MARKETING_ERRORS.name })
  })
  it("indicateurs : agrégations par campagne et par source SÉPARÉES ; la source ne dépend pas des campagnes affichées ; sans taux", () => {
    // v2 de revue : la campagne kX (hors liste affichée) a 9 conversions de la source s1 ; l'agrégat par source (calculé en
    // base sur toutes les campagnes) les compte, la ligne par campagne n'affiche que les campagnes listées.
    const r = computeIndicators(
      [{ id: "s1", name: "Salon", channel: "EVENT" }, { id: "s2", name: "Site", channel: "WEBSITE" }],
      [{ id: "k1", name: "Salon 2026", sourceId: "s1" }, { id: "k2", name: "Stand", sourceId: "s1" }, { id: "k3", name: "Page", sourceId: "s2" }],
      [{ campaignId: "k1", convertedOrders: 2, attributedHTCents: C(5000) }, { campaignId: "k2", convertedOrders: 1, attributedHTCents: C(1) }, { campaignId: "kX", convertedOrders: 9, attributedHTCents: C(9) }],
      [{ sourceId: "s1", convertedOrders: 12, attributedHTCents: C(5010) }, { sourceId: "sX", convertedOrders: 4, attributedHTCents: C(4) }],
    )
    assert.deepEqual(r.campaigns.map((k) => [k.campaignId, k.convertedOrders, k.attributedHTCents]), [["k1", 2, C(5000)], ["k2", 1, C(1)], ["k3", 0, C(0)]])
    assert.deepEqual(r.sources.map((s) => [s.sourceId, s.convertedOrders, s.attributedHTCents]), [["s1", 12, C(5010)], ["s2", 0, C(0)]])
    assert.ok(r.campaigns.every((k) => !("rate" in k)) && r.sources.every((s) => !("rate" in s)), "aucun taux")
  })
  it("drapeau serveur strict, désactivé par défaut", () => {
    assert.equal(isMarketingShopEnabled({}), false)
    for (const v of ["1", "TRUE", "yes", " true"]) assert.equal(isMarketingShopEnabled({ MARKETING_SHOP_ENABLED: v }), false, v)
    assert.equal(isMarketingShopEnabled({ MARKETING_SHOP_ENABLED: "true" }), true)
  })
})
