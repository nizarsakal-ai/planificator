/**
 * Garde d'accès du module assistant (Lot F V2). Même règle que les lots A, B et E (ADMIN ou SUPER_ADMIN avec la
 * société active de la session) : la logique pure `resolveStockAccessCore` est réutilisée telle quelle, seul le
 * drapeau diffère. Le `companyId` vient TOUJOURS de la session. Ne jamais importer depuis un composant client.
 * Pilote du 20/11/2026 : la société ACTIVE de la session doit être exactement la cible du module ; toute autre société,
 * Super Admin compris, voit le module inexistant (MODULE_DISABLED). Aucune garde sans cible.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { readAssistantPilotCompanyId } from "@/lib/assistant/assistant-feature-flag"
import { matchesLotFPilot } from "@/lib/lot-f/pilot-target"
import { pageDecision, resolveStockAccessCore, stockAccessMessage, type StockAccessResult, type StockContext, type StockDenial, type StockSessionLike } from "@/lib/stock/access"

export type AssistantAccessContext = StockContext
export type AssistantDenial = StockDenial

export class AssistantAccessError extends Error {
  constructor(readonly reason: AssistantDenial) {
    super(`ASSISTANT_ACCESS_DENIED:${reason}`)
    this.name = "AssistantAccessError"
  }
}

/** Logique pure (testable) : cible → session → société de session exactement égale à la cible (sinon MODULE_DISABLED,
 * quel que soit le rôle) → règle commune ADMIN/SUPER_ADMIN (`resolveStockAccessCore`, inchangée). */
export function resolveAssistantAccessCore(pilotCompanyId: string | null, session: StockSessionLike | null): StockAccessResult {
  if (!pilotCompanyId) return { ok: false, reason: "MODULE_DISABLED" }
  const base = resolveStockAccessCore(true, session)
  if (!base.ok && base.reason === "UNAUTHENTICATED") return base
  if (!matchesLotFPilot(session?.user?.companyId, pilotCompanyId)) return { ok: false, reason: "MODULE_DISABLED" }
  return base
}

export async function resolveAssistantAccess(): Promise<StockAccessResult> {
  const pilotCompanyId = readAssistantPilotCompanyId()
  if (pilotCompanyId === null) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolveAssistantAccessCore(pilotCompanyId, session)
}

export async function requireAssistantAdmin(): Promise<AssistantAccessContext> {
  const r = await resolveAssistantAccess()
  if (!r.ok) throw new AssistantAccessError(r.reason)
  return r.context
}

/** Pages : même décision que les lots A, B et E sur la base (pageDecision) — 404 si module désactivé, /login si non connecté ;
 * rôle ou société non habilités ⇒ `null`, refus rendu sur place (AdminOnlyNotice) AVANT toute lecture métier, sans
 * redirection (portage ab987847 : la redirection vers /dashboard du 04/11 provoquait React #310 en rendu en flux). */
export async function assistantPageAccess(): Promise<AssistantAccessContext | null> {
  const r = await resolveAssistantAccess()
  if (r.ok) return r.context
  const decision = pageDecision(r.reason)
  if (decision === "NOT_FOUND") notFound()
  if (decision === "LOGIN") redirect("/login")
  return null
}

/** Export (Route Handler) : réponse HTTP au lieu d'une redirection ; 404 si module désactivé (il n'existe pas). */
export function assistantDenialStatus(reason: AssistantDenial): 401 | 403 | 404 {
  return reason === "MODULE_DISABLED" ? 404 : reason === "UNAUTHENTICATED" ? 401 : 403
}

export const assistantAccessMessage = stockAccessMessage
