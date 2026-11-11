/**
 * Garde d'accès du module matériel et location (Lot B V2). Même règle que le lot A (ADMIN ou SUPER_ADMIN avec la
 * société active de la session) : la logique pure `resolveStockAccessCore` est réutilisée telle quelle, seul le
 * drapeau diffère. Le `companyId` vient TOUJOURS de la session. Ne jamais importer depuis un composant client.
 */
import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { isEquipmentRentalEnabled } from "@/lib/equipment/equipment-feature-flag"
import { pageDecision, resolveStockAccessCore, stockAccessMessage, type StockAccessResult, type StockContext, type StockDenial, type StockSessionLike } from "@/lib/stock/access"

export type EquipmentContext = StockContext
export type EquipmentDenial = StockDenial

export class EquipmentAccessError extends Error {
  constructor(readonly reason: EquipmentDenial) {
    super(`EQUIPMENT_ACCESS_DENIED:${reason}`)
    this.name = "EquipmentAccessError"
  }
}

/** Logique pure (testable) : drapeau → session → rôle → société. */
export function resolveEquipmentAccessCore(enabled: boolean, session: StockSessionLike | null): StockAccessResult {
  return resolveStockAccessCore(enabled, session)
}

export async function resolveEquipmentAccess(): Promise<StockAccessResult> {
  if (!isEquipmentRentalEnabled()) return { ok: false, reason: "MODULE_DISABLED" }
  let session: StockSessionLike | null
  try { session = await auth() } catch { return { ok: false, reason: "UNAUTHENTICATED" } }
  return resolveEquipmentAccessCore(true, session)
}

export async function requireEquipmentAdmin(): Promise<EquipmentContext> {
  const r = await resolveEquipmentAccess()
  if (!r.ok) throw new EquipmentAccessError(r.reason)
  return r.context
}

/** Pages : même décision que le lot A (pageDecision) — 404 si module désactivé, /login si non connecté ; rôle ou société non
 * habilités ⇒ `null`, refus rendu sur place (AdminOnlyNotice) AVANT toute lecture métier, sans redirection (React #310, VM B r4). */
export async function equipmentPageAccess(): Promise<EquipmentContext | null> {
  const r = await resolveEquipmentAccess()
  if (r.ok) return r.context
  const decision = pageDecision(r.reason)
  if (decision === "NOT_FOUND") notFound()
  if (decision === "LOGIN") redirect("/login")
  return null
}

export const equipmentAccessMessage = stockAccessMessage
