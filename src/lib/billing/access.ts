/**
 * Garde d'accès de la facturation complète (Lot C). Même règle que /factures : ADMIN ou SUPER_ADMIN avec une
 * société ACTIVE de session ; le `companyId` vient TOUJOURS de la session, jamais d'une entrée client.
 * Le drapeau BILLING_COMPLETE_ENABLED est contrôlé AVANT la session (OFF ⇒ la fonctionnalité n'existe pas).
 * Ne jamais importer ce fichier depuis un composant client.
 */
import { notFound, redirect } from "next/navigation"
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { isBillingCompleteEnabled } from "@/lib/billing/billing-feature-flag"

export type BillingDenial = "MODULE_DISABLED" | "UNAUTHENTICATED" | "FORBIDDEN" | "NO_COMPANY"

export interface BillingContext {
  userId: string
  companyId: string
  role: "ADMIN" | "SUPER_ADMIN"
}

export class BillingAccessError extends Error {
  constructor(readonly reason: BillingDenial) {
    super(`BILLING_ACCESS_DENIED:${reason}`)
    this.name = "BillingAccessError"
  }
}

export type BillingAccessResult = { ok: true; context: BillingContext } | { ok: false; reason: BillingDenial }

export interface BillingSessionLike { user?: { id?: string | null; role?: string | null; companyId?: string | null } | null }

/** Logique pure (testable) : drapeau → session → rôle → société. */
export function resolveBillingAccessCore(enabled: boolean, session: BillingSessionLike | null): BillingAccessResult {
  if (enabled !== true) return { ok: false, reason: "MODULE_DISABLED" }
  const user = session?.user
  const userId = typeof user?.id === "string" ? user.id.trim() : ""
  if (!user || !userId) return { ok: false, reason: "UNAUTHENTICATED" }
  if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") return { ok: false, reason: "FORBIDDEN" }
  const companyId = typeof user.companyId === "string" ? user.companyId.trim() : ""
  if (!companyId) return { ok: false, reason: "NO_COMPANY" }
  return { ok: true, context: { userId, companyId, role: user.role } }
}

export async function resolveBillingAccess(): Promise<BillingAccessResult> {
  if (!isBillingCompleteEnabled()) return { ok: false, reason: "MODULE_DISABLED" }
  let session: BillingSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolveBillingAccessCore(true, session)
}

/** Server Actions : lève BillingAccessError si refus. */
export async function requireBillingAdmin(): Promise<BillingContext> {
  const r = await resolveBillingAccess()
  if (!r.ok) throw new BillingAccessError(r.reason)
  return r.context
}

/** Pages : 404 si module désactivé, /login si non connecté, /dashboard sinon. */
export async function requireBillingPage(): Promise<BillingContext> {
  const r = await resolveBillingAccess()
  if (r.ok) return r.context
  if (r.reason === "MODULE_DISABLED") notFound()
  if (r.reason === "UNAUTHENTICATED") redirect("/login")
  redirect("/dashboard")
}

/** Route Handlers (PDF, exports) : réponses HTTP sans corps. */
export async function requireBillingRoute(): Promise<{ ok: true; ctx: BillingContext } | { ok: false; response: NextResponse }> {
  const r = await resolveBillingAccess()
  if (r.ok) return { ok: true, ctx: r.context }
  const status = r.reason === "MODULE_DISABLED" ? 404 : r.reason === "UNAUTHENTICATED" ? 401 : 403
  return { ok: false, response: new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } }) }
}

/** Message utilisateur pour une erreur d'accès (sans révéler l'existence du module quand il est désactivé). */
export function billingAccessMessage(reason: BillingDenial): string {
  return reason === "MODULE_DISABLED" ? "Fonctionnalité indisponible." : reason === "UNAUTHENTICATED" ? "Non authentifié." : "Accès refusé."
}
