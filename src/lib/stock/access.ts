/**
 * Garde d'accès du module stocks et achats (Lot A V2). Même règle que la facturation complète : ADMIN ou
 * SUPER_ADMIN avec la société active de la session (résolue par l'appartenance multi-société au callback JWT, comme
 * pour la facturation ; aucune vérification supplémentaire ici) ; le `companyId` vient TOUJOURS de la session, jamais d'une entrée
 * client. Le drapeau est contrôlé AVANT la session (désactivé ⇒ la fonctionnalité n'existe pas).
 * Ne jamais importer ce fichier depuis un composant client.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isStockPurchasingEnabled } from "@/lib/stock/stock-feature-flag"

export type StockDenial = "MODULE_DISABLED" | "UNAUTHENTICATED" | "FORBIDDEN" | "NO_COMPANY"
export interface StockContext { userId: string; companyId: string; role: "ADMIN" | "SUPER_ADMIN" }
export type StockAccessResult = { ok: true; context: StockContext } | { ok: false; reason: StockDenial }
export interface StockSessionLike { user?: { id?: string | null; role?: string | null; companyId?: string | null } | null }

export class StockAccessError extends Error {
  constructor(readonly reason: StockDenial) {
    super(`STOCK_ACCESS_DENIED:${reason}`)
    this.name = "StockAccessError"
  }
}

/** Logique pure (testable) : drapeau → session → rôle → société. */
export function resolveStockAccessCore(enabled: boolean, session: StockSessionLike | null): StockAccessResult {
  if (enabled !== true) return { ok: false, reason: "MODULE_DISABLED" }
  const user = session?.user
  const userId = typeof user?.id === "string" ? user.id.trim() : ""
  if (!user || !userId) return { ok: false, reason: "UNAUTHENTICATED" }
  if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") return { ok: false, reason: "FORBIDDEN" }
  const companyId = typeof user.companyId === "string" ? user.companyId.trim() : ""
  if (!companyId) return { ok: false, reason: "NO_COMPANY" }
  return { ok: true, context: { userId, companyId, role: user.role } }
}

export async function resolveStockAccess(): Promise<StockAccessResult> {
  if (!isStockPurchasingEnabled()) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolveStockAccessCore(true, session)
}

/** Actions serveur : lève StockAccessError si refus. */
export async function requireStockAdmin(): Promise<StockContext> {
  const r = await resolveStockAccess()
  if (!r.ok) throw new StockAccessError(r.reason)
  return r.context
}

/** Décision de page (pure, testable) : module désactivé ⇒ 404 ; non connecté ⇒ /login ; rôle ou société non habilités ⇒
 * refus RENDU SUR PLACE. Plus de redirection vers /dashboard : levée pendant le rendu en flux (loading.tsx du tableau de
 * bord), elle provoquait l'erreur client React #310 et une page vide (preuves VM B r4). Même choix que le refus Employés V1. */
export type PageDecision = "NOT_FOUND" | "LOGIN" | "DENIED"
export function pageDecision(reason: StockDenial): PageDecision {
  if (reason === "MODULE_DISABLED") return "NOT_FOUND"
  if (reason === "UNAUTHENTICATED") return "LOGIN"
  return "DENIED"
}

/** Pages : contexte si habilité ; `null` si refus à rendre sur place (AdminOnlyNotice), AVANT toute lecture métier. */
export async function stockPageAccess(): Promise<StockContext | null> {
  const r = await resolveStockAccess()
  if (r.ok) return r.context
  const decision = pageDecision(r.reason)
  if (decision === "NOT_FOUND") notFound()
  if (decision === "LOGIN") redirect("/login")
  return null
}

/** Message utilisateur sans révéler l'existence du module quand il est désactivé. */
export function stockAccessMessage(reason: StockDenial): string {
  return reason === "MODULE_DISABLED" ? "Fonctionnalité indisponible." : reason === "UNAUTHENTICATED" ? "Non authentifié." : "Accès refusé."
}
