/**
 * Garde d'accès du module réserves et procès-verbaux (Lot D V2). Même règle que les lots A, B et C (ADMIN ou SUPER_ADMIN avec la
 * société active de la session) : la logique pure `resolveStockAccessCore` est réutilisée telle quelle, seul le
 * drapeau diffère. Le `companyId` vient TOUJOURS de la session. Ne jamais importer depuis un composant client.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isWorksiteReservesEnabled } from "@/lib/reserves/reserves-feature-flag"
import { pageDecision, resolveStockAccessCore, stockAccessMessage, type StockAccessResult, type StockContext, type StockDenial, type StockSessionLike } from "@/lib/stock/access"

export type ReserveContext = StockContext
export type ReserveDenial = StockDenial

export class ReserveAccessError extends Error {
  constructor(readonly reason: ReserveDenial) {
    super(`RESERVE_ACCESS_DENIED:${reason}`)
    this.name = "ReserveAccessError"
  }
}

/** Logique pure (testable) : drapeau → session → rôle → société. */
export function resolveReserveAccessCore(enabled: boolean, session: StockSessionLike | null): StockAccessResult {
  return resolveStockAccessCore(enabled, session)
}

export async function resolveReserveAccess(): Promise<StockAccessResult> {
  if (!isWorksiteReservesEnabled()) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolveReserveAccessCore(true, session)
}

export async function requireReserveAdmin(): Promise<ReserveContext> {
  const r = await resolveReserveAccess()
  if (!r.ok) throw new ReserveAccessError(r.reason)
  return r.context
}

/** Décision de page : même règle pure que les lots A, B et C (`pageDecision`) : module désactivé ⇒ 404 ; non connecté ⇒
 * /login ; rôle ou société non habilités ⇒ refus RENDU SUR PLACE (AdminOnlyNotice). Aucune redirection vers /dashboard
 * pendant le rendu en flux (React #310 constaté en VM B r4). Réconciliation du lot D sur l'arbre publié b0a2523e. */
export const reservePageDecision = pageDecision

/** Pages : contexte si habilité ; `null` si refus à rendre sur place, AVANT toute lecture métier. */
export async function reservePageAccess(): Promise<ReserveContext | null> {
  const r = await resolveReserveAccess()
  if (r.ok) return r.context
  const decision = reservePageDecision(r.reason)
  if (decision === "NOT_FOUND") notFound()
  if (decision === "LOGIN") redirect("/login")
  return null
}

/** PDF et fichiers (Route Handlers) : réponse HTTP au lieu d'une redirection ; 404 si module désactivé (il n'existe pas). */
export function reserveDenialStatus(reason: ReserveDenial): 401 | 403 | 404 {
  return reason === "MODULE_DISABLED" ? 404 : reason === "UNAUTHENTICATED" ? 401 : 403
}

export const reserveAccessMessage = stockAccessMessage
