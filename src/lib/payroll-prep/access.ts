/**
 * Garde d'accès du module pré-paie (Lot H V2). Même règle que les lots A et B (ADMIN ou SUPER_ADMIN avec la
 * société active de la session) : la logique pure `resolveStockAccessCore` est réutilisée telle quelle, seul le
 * drapeau diffère. Le `companyId` vient TOUJOURS de la session. Ne jamais importer depuis un composant client.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isPayrollPrepEnabled } from "@/lib/payroll-prep/prepay-feature-flag"
import { pageDecision, resolveStockAccessCore, stockAccessMessage, type StockAccessResult, type StockContext, type StockDenial, type StockSessionLike } from "@/lib/stock/access"

export type PrepayAccessContext = StockContext
export type PrepayDenial = StockDenial

export class PrepayAccessError extends Error {
  constructor(readonly reason: PrepayDenial) {
    super(`PREPAY_ACCESS_DENIED:${reason}`)
    this.name = "PrepayAccessError"
  }
}

/** Logique pure (testable) : drapeau → session → rôle → société. */
export function resolvePrepayAccessCore(enabled: boolean, session: StockSessionLike | null): StockAccessResult {
  return resolveStockAccessCore(enabled, session)
}

export async function resolvePrepayAccess(): Promise<StockAccessResult> {
  if (!isPayrollPrepEnabled()) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolvePrepayAccessCore(true, session)
}

export async function requirePrepayAdmin(): Promise<PrepayAccessContext> {
  const r = await resolvePrepayAccess()
  if (!r.ok) throw new PrepayAccessError(r.reason)
  return r.context
}

/**
 * Pages (portage sur 90ae644, comme le portage G) : contexte si habilité ; `null` si le refus (rôle ou société non
 * habilités) est à RENDRE SUR PLACE par `AdminOnlyNotice`, AVANT toute lecture métier. 404 si module désactivé, /login
 * si non connecté. Plus de redirection vers /dashboard (erreur client React #310 en rendu en flux).
 */
export async function prepayPageAccess(): Promise<PrepayAccessContext | null> {
  const r = await resolvePrepayAccess()
  if (r.ok) return r.context
  const decision = pageDecision(r.reason)
  if (decision === "NOT_FOUND") notFound()
  if (decision === "LOGIN") redirect("/login")
  return null
}

/** Export (Route Handler) : réponse HTTP au lieu d'une redirection ; 404 si module désactivé (il n'existe pas). */
export function prepayDenialStatus(reason: PrepayDenial): 401 | 403 | 404 {
  return reason === "MODULE_DISABLED" ? 404 : reason === "UNAUTHENTICATED" ? 401 : 403
}

export const prepayAccessMessage = stockAccessMessage
