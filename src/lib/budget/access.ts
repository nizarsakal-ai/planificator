/**
 * Garde d'accès du module budgets et marges (Lot C V2). Même règle que les lots A et B (ADMIN ou SUPER_ADMIN avec la
 * société active de la session) : la logique pure `resolveStockAccessCore` est réutilisée telle quelle, seul le
 * drapeau diffère. Le `companyId` vient TOUJOURS de la session. Ne jamais importer depuis un composant client.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isWorksiteBudgetEnabled } from "@/lib/budget/budget-feature-flag"
import { pageDecision, resolveStockAccessCore, stockAccessMessage, type StockAccessResult, type StockContext, type StockDenial, type StockSessionLike } from "@/lib/stock/access"

export type BudgetContext = StockContext
export type BudgetDenial = StockDenial

export class BudgetAccessError extends Error {
  constructor(readonly reason: BudgetDenial) {
    super(`BUDGET_ACCESS_DENIED:${reason}`)
    this.name = "BudgetAccessError"
  }
}

/** Logique pure (testable) : drapeau → session → rôle → société. */
export function resolveBudgetAccessCore(enabled: boolean, session: StockSessionLike | null): StockAccessResult {
  return resolveStockAccessCore(enabled, session)
}

export async function resolveBudgetAccess(): Promise<StockAccessResult> {
  if (!isWorksiteBudgetEnabled()) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolveBudgetAccessCore(true, session)
}

export async function requireBudgetAdmin(): Promise<BudgetContext> {
  const r = await resolveBudgetAccess()
  if (!r.ok) throw new BudgetAccessError(r.reason)
  return r.context
}

/** Décision de page : même règle pure que les lots A et B (`pageDecision`) : module désactivé ⇒ 404 ; non connecté ⇒
 * /login ; rôle ou société non habilités ⇒ refus RENDU SUR PLACE (AdminOnlyNotice). Aucune redirection vers /dashboard
 * pendant le rendu en flux (React #310 constaté en VM B r4). Intégration du lot C sur l'arbre publié 35c0f227. */
export const budgetPageDecision = pageDecision

/** Pages : contexte si habilité ; `null` si refus à rendre sur place, AVANT toute lecture métier. */
export async function budgetPageAccess(): Promise<BudgetContext | null> {
  const r = await resolveBudgetAccess()
  if (r.ok) return r.context
  const decision = budgetPageDecision(r.reason)
  if (decision === "NOT_FOUND") notFound()
  if (decision === "LOGIN") redirect("/login")
  return null
}

/** Export (Route Handler) : réponse HTTP au lieu d'une redirection ; 404 si module désactivé (il n'existe pas). */
export function budgetDenialStatus(reason: BudgetDenial): 401 | 403 | 404 {
  return reason === "MODULE_DISABLED" ? 404 : reason === "UNAUTHENTICATED" ? 401 : 403
}

export const budgetAccessMessage = stockAccessMessage
