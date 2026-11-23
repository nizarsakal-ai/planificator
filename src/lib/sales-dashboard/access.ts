/**
 * Garde d'accès du module tableaux de bord commerciaux (Lot D V2). Même règle que les lots A, B et C (ADMIN ou SUPER_ADMIN avec la
 * société active de la session) : la logique pure `resolveStockAccessCore` est réutilisée telle quelle, seul le
 * drapeau diffère. Le `companyId` vient TOUJOURS de la session. Ne jamais importer depuis un composant client.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isSalesDashboardEnabled } from "@/lib/sales-dashboard/sales-feature-flag"
import { pageDecision, resolveStockAccessCore, stockAccessMessage, type StockAccessResult, type StockContext, type StockDenial, type StockSessionLike } from "@/lib/stock/access"

export type SalesContext = StockContext
export type SalesDenial = StockDenial

export class SalesAccessError extends Error {
  constructor(readonly reason: SalesDenial) {
    super(`SALES_ACCESS_DENIED:${reason}`)
    this.name = "SalesAccessError"
  }
}

/** Logique pure (testable) : drapeau → session → rôle → société. */
export function resolveSalesAccessCore(enabled: boolean, session: StockSessionLike | null): StockAccessResult {
  return resolveStockAccessCore(enabled, session)
}

export async function resolveSalesAccess(): Promise<StockAccessResult> {
  if (!isSalesDashboardEnabled()) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolveSalesAccessCore(true, session)
}

export async function requireSalesAdmin(): Promise<SalesContext> {
  const r = await resolveSalesAccess()
  if (!r.ok) throw new SalesAccessError(r.reason)
  return r.context
}

/** Décision de page : même règle pure que les lots A, B et C (`pageDecision`) : module désactivé ⇒ 404 ; non connecté ⇒
 * /login ; rôle ou société non habilités ⇒ refus RENDU SUR PLACE (AdminOnlyNotice). Aucune redirection vers /dashboard
 * pendant le rendu en flux (React #310 constaté en VM B r4). Réconciliation du lot D sur l'arbre publié b0a2523e. */
export const salesPageDecision = pageDecision

/** Pages : contexte si habilité ; `null` si refus à rendre sur place, AVANT toute lecture métier. */
export async function salesPageAccess(): Promise<SalesContext | null> {
  const r = await resolveSalesAccess()
  if (r.ok) return r.context
  const decision = salesPageDecision(r.reason)
  if (decision === "NOT_FOUND") notFound()
  if (decision === "LOGIN") redirect("/login")
  return null
}

/** Export (Route Handler) : réponse HTTP au lieu d'une redirection ; 404 si module désactivé (il n'existe pas). */
export function salesDenialStatus(reason: SalesDenial): 401 | 403 | 404 {
  return reason === "MODULE_DISABLED" ? 404 : reason === "UNAUTHENTICATED" ? 401 : 403
}

export const salesAccessMessage = stockAccessMessage
