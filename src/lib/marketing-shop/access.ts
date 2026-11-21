/**
 * Garde serveur du lot I (Marketing et Boutique). Le contrôle commun des rôles s'applique dans la
 * société pilote. L'identifiant de société vient de la session.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { readMarketingShopPilotCompanyId } from "@/lib/marketing-shop/marketing-shop-feature-flag"
import { pageDecision, resolveStockAccessCore, stockAccessMessage, type StockAccessResult, type StockContext, type StockDenial, type StockSessionLike } from "@/lib/stock/access"

export type MarketingShopContext = StockContext
export type MarketingShopDenial = StockDenial

export class MarketingShopAccessError extends Error {
  constructor(readonly reason: MarketingShopDenial) {
    super(`MARKETING_SHOP_ACCESS_DENIED:${reason}`)
    this.name = "MarketingShopAccessError"
  }
}

export function resolveMarketingShopAccessCore(pilotCompanyId: string | null, session: StockSessionLike | null): StockAccessResult {
  if (!pilotCompanyId) return { ok: false, reason: "MODULE_DISABLED" }
  const base = resolveStockAccessCore(true, session)
  if (!base.ok && base.reason === "UNAUTHENTICATED") return base
  if (session?.user?.companyId !== pilotCompanyId) return { ok: false, reason: "MODULE_DISABLED" }
  return base
}

export async function resolveMarketingShopAccess(): Promise<StockAccessResult> {
  const pilotCompanyId = readMarketingShopPilotCompanyId()
  if (pilotCompanyId === null) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolveMarketingShopAccessCore(pilotCompanyId, session)
}

/** Actions : contexte ou erreur typée (aucune écriture sans drapeau, session, rôle et société). */
export async function requireMarketingShopAdmin(): Promise<MarketingShopContext> {
  const r = await resolveMarketingShopAccess()
  if (!r.ok) throw new MarketingShopAccessError(r.reason)
  return r.context
}

/**
 * Pages : contexte si habilité ; `null` si le refus (rôle ou société non habilités) est à RENDRE SUR PLACE par
 * `AdminOnlyNotice`, AVANT toute lecture métier. Drapeau désactivé : page introuvable (notFound) ; non connecté : /login.
 */
export async function marketingShopPageAccess(): Promise<MarketingShopContext | null> {
  const r = await resolveMarketingShopAccess()
  if (r.ok) return r.context
  const decision = pageDecision(r.reason)
  if (decision === "NOT_FOUND") notFound()
  if (decision === "LOGIN") redirect("/login")
  return null
}

export const marketingShopAccessMessage = stockAccessMessage
