"use server"
// Lot I Planificator V2 : actions serveur du marketing et de la boutique de simulation (ADMIN ou SUPER_ADMIN de la
// société de session, drapeau MARKETING_SHOP_ENABLED). Aucun identifiant de société ni aucun prix lu du formulaire.
// Retour EXPLICITE par état (RetourAction, mécanisme qualifié E4) : le client (FormulaireRetour) ouvre par une navigation
// native la fiche de la commande créée (cible calculée ICI depuis l'identifiant rendu par le service) ou rouvre la page
// courante ; adresses limitées par la liste blanche de retour-action.ts. Seule redirection serveur : /login.
// Entrées BORNÉES SANS TRONCATURE : une valeur trop longue est refusée, jamais coupée puis validée.
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { MarketingShopAccessError, marketingShopAccessMessage, requireMarketingShopAdmin, type MarketingShopContext } from "@/lib/marketing-shop/access"
import { MARKETING_ERRORS } from "@/lib/marketing-shop/marketing.core"
import { MAX_ORDER_LINES, SHOP_ERRORS } from "@/lib/marketing-shop/shop.core"
import * as marketing from "@/lib/marketing-shop/marketing.service"
import * as shop from "@/lib/marketing-shop/shop.service"
import { formulaireDe, retour, type RetourAction } from "@/lib/actions/retour-action"

const ID = /^[A-Za-z0-9_-]{1,64}$/
/** Valeur texte du champ, sans espaces de bord ; `null` si elle dépasse `max` (refusée, jamais tronquée). */
function champ(f: FormData, k: string, max: number): string | null {
  const v = f.get(k)
  const s = typeof v === "string" ? v.trim() : ""
  return s.length > max ? null : s
}
/** Identifiant borné ; "" si absent, trop long ou hors alphabet (l'entité est alors introuvable pour le service). */
const reqId = (f: FormData, k: string) => { const v = champ(f, k, 64); return v && ID.test(v) ? v : "" }
type Outcome = { ok: true; okMessage: string; cible?: string } | { ok: false; error: string }
/** Fiche d'une commande : cible calculée côté serveur depuis l'identifiant rendu par le service. */
const ficheCommande = (orderId: string) => `/boutique/commandes/${orderId}`

async function run(fn: (ctx: MarketingShopContext) => Promise<Outcome>): Promise<RetourAction> {
  let result: Outcome
  try {
    result = await fn(await requireMarketingShopAdmin())
  } catch (e) {
    if (e instanceof MarketingShopAccessError && e.reason === "UNAUTHENTICATED") redirect("/login")
    if (e instanceof MarketingShopAccessError) return retour(false, marketingShopAccessMessage(e.reason))
    console.error("[marketing-boutique] action en échec", e instanceof Error ? e.name : "erreur")
    return retour(false, "Opération impossible pour le moment.")
  }
  return result.ok ? retour(true, result.okMessage, result.cible) : retour(false, result.error)
}

// ── Marketing ──────────────────────────────────────────────────────────────────────────────────────────────────────
export async function createSourceAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const channel = champ(form, "channel", 20), name = champ(form, "name", 120)
    if (channel === null) return { ok: false, error: MARKETING_ERRORS.channel }
    if (name === null) return { ok: false, error: MARKETING_ERRORS.name }
    const r = await marketing.createSource(prisma, ctx, { channel, name })
    return r.ok ? { ok: true, okMessage: "Source créée." } : r
  })
}
export async function createCampaignAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const name = champ(form, "name", 120), startsOn = champ(form, "startsOn", 10), endsOn = champ(form, "endsOn", 10)
    if (name === null) return { ok: false, error: MARKETING_ERRORS.name }
    if (startsOn === null || endsOn === null) return { ok: false, error: MARKETING_ERRORS.dates }
    const r = await marketing.createCampaign(prisma, ctx, { sourceId: reqId(form, "sourceId"), name, startsOn, endsOn })
    return r.ok ? { ok: true, okMessage: "Campagne créée." } : r
  })
}
export async function grantConsentAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    if (champ(form, "confirm", 5) !== "oui") return { ok: false, error: "Cochez la confirmation : le client a donné son accord explicite." }
    const r = await marketing.grantConsent(prisma, ctx, reqId(form, "clientId"))
    return r.ok ? { ok: true, okMessage: "Consentement accordé." } : r
  })
}
export async function withdrawConsentAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const r = await marketing.withdrawConsent(prisma, ctx, reqId(form, "clientId"))
    return r.ok ? { ok: true, okMessage: "Consentement retiré." } : r
  })
}
export async function attributeOrderAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const r = await marketing.attributeOrder(prisma, ctx, { orderId: reqId(form, "orderId"), campaignId: reqId(form, "campaignId") })
    return r.ok ? { ok: true, okMessage: "Commande attribuée à la campagne." } : r
  })
}

// ── Boutique (simulation) ──────────────────────────────────────────────────────────────────────────────────────────
export async function createPromotionAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const code = champ(form, "code", 32), percent = champ(form, "percent", 6), validFrom = champ(form, "validFrom", 10), validUntil = champ(form, "validUntil", 10)
    if (code === null) return { ok: false, error: SHOP_ERRORS.promoFormat }
    if (percent === null) return { ok: false, error: SHOP_ERRORS.promoPercent }
    if (validFrom === null || validUntil === null) return { ok: false, error: SHOP_ERRORS.promoWindow }
    const r = await shop.createPromotion(prisma, ctx, { code, percent, validFrom, validUntil })
    return r.ok ? { ok: true, okMessage: "Promotion créée et active." } : r
  })
}
export async function setPromotionActiveAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const active = champ(form, "active", 3)
    if (active !== "oui" && active !== "non") return { ok: false, error: SHOP_ERRORS.notFound }
    const r = await shop.setPromotionActive(prisma, ctx, reqId(form, "promotionId"), active === "oui")
    return r.ok ? { ok: true, okMessage: active === "oui" ? "Promotion activée." : "Promotion désactivée." } : r
  })
}
export async function createOrderAction(a: RetourAction | FormData, b?: FormData) {
  const form = formulaireDe(a, b)
  return run(async (ctx) => {
    const key = champ(form, "idempotencyKey", 64), promoCode = champ(form, "promoCode", 32)
    if (key === null) return { ok: false, error: SHOP_ERRORS.idempotencyKey }
    if (promoCode === null) return { ok: false, error: SHOP_ERRORS.promoFormat }
    const lines: { articleId: string; quantity: string }[] = []
    for (let i = 1; i <= MAX_ORDER_LINES; i++) {
      const articleId = champ(form, `articleId_${i}`, 64), quantity = champ(form, `quantity_${i}`, 3)
      if (articleId === null) return { ok: false, error: SHOP_ERRORS.article }
      if (quantity === null) return { ok: false, error: SHOP_ERRORS.quantity }
      lines.push({ articleId, quantity })
    }
    const r = await shop.createOrder(prisma, ctx, { idempotencyKey: key, clientId: reqId(form, "clientId"), lines, promoCode })
    if (!r.ok) return r
    return { ok: true, okMessage: r.value.replayed ? "Commande déjà enregistrée (envoi répété) : aucune nouvelle commande." : "Commande de simulation enregistrée.", cible: ficheCommande(r.value.id) }
  })
}
