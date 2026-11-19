/**
 * Garde d'accès du lot I (marketing et boutique). Même règle que les lots A et B (ADMIN ou SUPER_ADMIN avec la société
 * active de la session) : la logique pure `resolveStockAccessCore` et la décision de page `pageDecision` du stock sont
 * réutilisées telles quelles, seul le drapeau diffère. Le `companyId` vient TOUJOURS de la session. Ne jamais importer
 * depuis un composant client.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isMarketingShopEnabled } from "@/lib/marketing-shop/marketing-shop-feature-flag"
import { pageDecision, resolveStockAccessCore, stockAccessMessage, type StockAccessResult, type StockContext, type StockDenial, type StockSessionLike } from "@/lib/stock/access"

export type MarketingShopContext = StockContext
export type MarketingShopDenial = StockDenial

export class MarketingShopAccessError extends Error {
  constructor(readonly reason: MarketingShopDenial) {
    super(`MARKETING_SHOP_ACCESS_DENIED:${reason}`)
    this.name = "MarketingShopAccessError"
  }
}

/** Logique pure (testable) : drapeau → session → rôle → société. */
export function resolveMarketingShopAccessCore(enabled: boolean, session: StockSessionLike | null): StockAccessResult {
  return resolveStockAccessCore(enabled, session)
}

export async function resolveMarketingShopAccess(): Promise<StockAccessResult> {
  if (!isMarketingShopEnabled()) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolveMarketingShopAccessCore(true, session)
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
