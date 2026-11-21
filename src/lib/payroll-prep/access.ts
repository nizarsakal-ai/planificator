/**
 * Garde serveur de Pré-paie (Lot H V2). Seuls les ADMIN et SUPER_ADMIN dont la société de session
 * correspond à la société pilote configurée côté serveur peuvent accéder au module.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { readPayrollPrepPilotCompanyId } from "@/lib/payroll-prep/prepay-feature-flag"
import { pageDecision, resolveStockAccessCore, stockAccessMessage, type StockAccessResult, type StockContext, type StockDenial, type StockSessionLike } from "@/lib/stock/access"

export type PrepayAccessContext = StockContext
export type PrepayDenial = StockDenial

export class PrepayAccessError extends Error {
  constructor(readonly reason: PrepayDenial) {
    super(`PREPAY_ACCESS_DENIED:${reason}`)
    this.name = "PrepayAccessError"
  }
}

/** Le contrôle commun des rôles s'applique dans la société pilote. */
export function resolvePrepayAccessCore(pilotCompanyId: string | null, session: StockSessionLike | null): StockAccessResult {
  if (pilotCompanyId === null) return { ok: false, reason: "MODULE_DISABLED" }
  const base = resolveStockAccessCore(true, session)
  if (!base.ok && base.reason === "UNAUTHENTICATED") return base
  if (session?.user?.companyId !== pilotCompanyId) return { ok: false, reason: "MODULE_DISABLED" }
  return base
}

export async function resolvePrepayAccess(): Promise<StockAccessResult> {
  const pilotCompanyId = readPayrollPrepPilotCompanyId()
  if (pilotCompanyId === null) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolvePrepayAccessCore(pilotCompanyId, session)
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
