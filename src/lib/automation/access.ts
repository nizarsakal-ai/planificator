/**
 * Garde d'accès du module automatisations (Lot E V2). Même règle que les lots A et B (ADMIN ou SUPER_ADMIN avec la
 * société active de la session) : la logique pure `resolveStockAccessCore` est réutilisée telle quelle, seul le
 * drapeau diffère. Le `companyId` vient TOUJOURS de la session. Ne jamais importer depuis un composant client.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isAutomationsEnabled } from "@/lib/automation/automation-feature-flag"
import { pageDecision, resolveStockAccessCore, stockAccessMessage, type StockAccessResult, type StockContext, type StockDenial, type StockSessionLike } from "@/lib/stock/access"

export type AutomationContext = StockContext
export type AutomationDenial = StockDenial

export class AutomationAccessError extends Error {
  constructor(readonly reason: AutomationDenial) {
    super(`AUTOMATION_ACCESS_DENIED:${reason}`)
    this.name = "AutomationAccessError"
  }
}

/** Logique pure (testable) : drapeau → session → rôle → société. */
export function resolveAutomationAccessCore(enabled: boolean, session: StockSessionLike | null): StockAccessResult {
  return resolveStockAccessCore(enabled, session)
}

export async function resolveAutomationAccess(): Promise<StockAccessResult> {
  if (!isAutomationsEnabled()) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolveAutomationAccessCore(true, session)
}

export async function requireAutomationAdmin(): Promise<AutomationContext> {
  const r = await resolveAutomationAccess()
  if (!r.ok) throw new AutomationAccessError(r.reason)
  return r.context
}

/** Pages : même décision que les lots A et B sur main (pageDecision) — 404 si module désactivé, /login si non connecté ; rôle ou
 * société non habilités ⇒ `null`, refus rendu sur place (AdminOnlyNotice) AVANT toute lecture métier, sans redirection (React #310). */
export async function automationPageAccess(): Promise<AutomationContext | null> {
  const r = await resolveAutomationAccess()
  if (r.ok) return r.context
  const decision = pageDecision(r.reason)
  if (decision === "NOT_FOUND") notFound()
  if (decision === "LOGIN") redirect("/login")
  return null
}

/** Export (Route Handler) : réponse HTTP au lieu d'une redirection ; 404 si module désactivé (il n'existe pas). */
export function automationDenialStatus(reason: AutomationDenial): 401 | 403 | 404 {
  return reason === "MODULE_DISABLED" ? 404 : reason === "UNAUTHENTICATED" ? 401 : 403
}

export const automationAccessMessage = stockAccessMessage
