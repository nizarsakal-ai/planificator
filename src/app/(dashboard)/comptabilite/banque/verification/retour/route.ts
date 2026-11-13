// Retour du parcours de vérification bancaire (SPEC-BANK-VERIF-001). Le paramètre `state` ne fait qu'identifier la session
// (usage unique, société de session) ; le résultat est relu chez le prestataire par le service — rien d'autre de l'URL n'est cru.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireAccountingRoute } from "@/lib/accounting/ui/route-guard"
import { isBankAccountVerificationEnabled } from "@/lib/invoice-import/invoice-import-feature-flag"
import { completeVerification } from "@/lib/bank-verification/bank-account.service"
import { resolveBankVerificationProvider } from "@/lib/bank-verification/provider"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const back = (code: string) => new NextResponse(null, { status: 303, headers: { Location: `/comptabilite/banque?verification=${code}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } })
  if (!isBankAccountVerificationEnabled()) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  const access = await requireAccountingRoute()
  if (!access.ok) return access.response
  const resolved = resolveBankVerificationProvider()
  if (!resolved.ok) return back("indisponible")
  const state = new URL(request.url).searchParams.get("state") ?? ""
  try {
    const r = await completeVerification(prisma, access.ctx, resolved.provider, state)
    if (!r.ok) return back("invalide")
    return back(r.value.status === "VERIFIED" ? "ok" : r.value.status === "PENDING" ? "attente" : "echec")
  } catch (error) {
    console.error("[banque] retour de vérification en échec", error instanceof Error ? error.name : "erreur")
    return back("erreur")
  }
}
