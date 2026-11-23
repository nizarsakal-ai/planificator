// Lot D : sélection d'un chantier depuis la liste (formulaire GET) → redirection vers sa page de réserves.
// Identifiant contrôlé par motif ; la page cible applique la garde et le bornage par entreprise (404 sinon).
import { NextResponse } from "next/server"
import { resolveReserveAccess, reserveDenialStatus } from "@/lib/reserves/access"

export const dynamic = "force-dynamic"
export async function GET(request: Request): Promise<Response> {
  const access = await resolveReserveAccess()
  if (!access.ok) return new NextResponse(null, { status: reserveDenialStatus(access.reason), headers: { "Cache-Control": "no-store" } })
  const id = new URL(request.url).searchParams.get("id") ?? ""
  const target = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? `/reserves/${id}` : "/reserves"
  return NextResponse.redirect(new URL(target, request.url), 303)
}
