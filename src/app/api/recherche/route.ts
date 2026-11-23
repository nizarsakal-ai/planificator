// Lot D Planificator V2 : point d'accès de la recherche globale (palette). GET ?q= ; JSON ; jamais mis en cache.
// Drapeau GLOBAL_SEARCH_ENABLED (sinon 404) ; session obligatoire (401) ; ADMIN ou SUPER_ADMIN avec société (403).
// Le companyId et le rôle viennent de la session ; chaque groupe suit le drapeau du module de destination.
// Limite de débit (après session et drapeau, AVANT toute requête en base) : 30 requêtes par minute et par utilisateur
// de la société, PAR INSTANCE serveur (réduction de charge, pas une garantie globale) ; au-delà, 429 sans donnée.
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { isGlobalSearchEnabled } from "@/lib/search/search-feature-flag"
import { globalSearch } from "@/lib/search/search.service"
import { isBillingCompleteEnabled } from "@/lib/billing/billing-feature-flag"
import { isEquipmentRentalEnabled } from "@/lib/equipment/equipment-feature-flag"
import { isWorksiteReservesEnabled } from "@/lib/reserves/reserves-feature-flag"
import { resolveStockAccessCore, type StockSessionLike } from "@/lib/stock/access"
import { searchRateLimiter } from "@/lib/search/search-rate-limit"

export const dynamic = "force-dynamic"
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })

export async function GET(request: Request): Promise<Response> {
  if (!isGlobalSearchEnabled()) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  let session: StockSessionLike | null
  try { session = await auth() } catch { session = null }
  const access = resolveStockAccessCore(true, session)
  if (!access.ok) return json({ error: "Accès refusé." }, access.reason === "UNAUTHENTICATED" ? 401 : 403)
  const rate = searchRateLimiter.check(access.context.companyId, access.context.userId)
  if (!rate.allowed) {
    return NextResponse.json({ error: "Trop de recherches : réessayez dans un instant." }, { status: 429, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Retry-After": String(rate.retryAfterSeconds) } })
  }
  const q = new URL(request.url).searchParams.get("q") ?? ""
  const result = await globalSearch(prisma, { companyId: access.context.companyId, role: access.context.role }, q, {
    billing: isBillingCompleteEnabled(), equipment: isEquipmentRentalEnabled(), reserves: isWorksiteReservesEnabled(),
  })
  return json(result)
}
