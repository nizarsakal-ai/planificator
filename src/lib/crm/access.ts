/**
 * Garde d'accès du module opportunités commerciales (Lot E V2). Même règle que les lots A et B (ADMIN ou SUPER_ADMIN avec la
 * société active de la session) : la logique pure `resolveStockAccessCore` est réutilisée telle quelle, seul le
 * drapeau diffère. Le `companyId` vient TOUJOURS de la session. Ne jamais importer depuis un composant client.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isCrmEnabled } from "@/lib/crm/crm-feature-flag"
import { pageDecision, resolveStockAccessCore, stockAccessMessage, type StockAccessResult, type StockContext, type StockDenial, type StockSessionLike } from "@/lib/stock/access"

export type CrmContext = StockContext
export type CrmDenial = StockDenial

export class CrmAccessError extends Error {
  constructor(readonly reason: CrmDenial) {
    super(`CRM_ACCESS_DENIED:${reason}`)
    this.name = "CrmAccessError"
  }
}

/** Logique pure (testable) : drapeau → session → rôle → société. */
export function resolveCrmAccessCore(enabled: boolean, session: StockSessionLike | null): StockAccessResult {
  return resolveStockAccessCore(enabled, session)
}

export async function resolveCrmAccess(): Promise<StockAccessResult> {
  if (!isCrmEnabled()) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolveCrmAccessCore(true, session)
}

export async function requireCrmAdmin(): Promise<CrmContext> {
  const r = await resolveCrmAccess()
  if (!r.ok) throw new CrmAccessError(r.reason)
  return r.context
}

/** Pages : même décision que les lots A et B sur main (pageDecision) — 404 si module désactivé, /login si non connecté ; rôle ou
 * société non habilités ⇒ `null`, refus rendu sur place (AdminOnlyNotice) AVANT toute lecture métier, sans redirection (React #310). */
export async function crmPageAccess(): Promise<CrmContext | null> {
  const r = await resolveCrmAccess()
  if (r.ok) return r.context
  const decision = pageDecision(r.reason)
  if (decision === "NOT_FOUND") notFound()
  if (decision === "LOGIN") redirect("/login")
  return null
}

/** Export (Route Handler) : réponse HTTP au lieu d'une redirection ; 404 si module désactivé (il n'existe pas). */
export function crmDenialStatus(reason: CrmDenial): 401 | 403 | 404 {
  return reason === "MODULE_DISABLED" ? 404 : reason === "UNAUTHENTICATED" ? 401 : 403
}

export const crmAccessMessage = stockAccessMessage
