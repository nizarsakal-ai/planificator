// Assistant IA, étape 2 : onglet Propositions (GET, lecture seule). Garde EXACTE de la route /assistant (lot F) :
// 404 lot inactif ou autre société, 401 sans session, 403 rôle non administrateur. Société de la garde uniquement.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { rulesSourceGuard } from "@/lib/copilot/copilot-guards"
import { readPendingProposals } from "@/lib/copilot/copilot-tabs"

export const dynamic = "force-dynamic"
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })

export async function GET(): Promise<Response> {
  const guard = await rulesSourceGuard()
  if (!guard.ok) return guard.status === 404 ? new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } }) : json({ error: "Accès refusé." }, guard.status)
  try {
    return json({ proposals: await readPendingProposals(prisma, guard) })
  } catch (error) {
    console.warn("assistant_tab_proposals_failed", { code: error instanceof Error ? error.name : "UNKNOWN" })
    return json({ error: "Propositions indisponibles pour le moment." }, 503)
  }
}
