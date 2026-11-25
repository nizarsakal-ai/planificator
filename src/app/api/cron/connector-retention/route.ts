import { NextResponse } from "next/server"
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { runConnectorRetention } from "@/lib/integration/connectors/live/retention.service"

export const maxDuration = 60

// LOT-8D — rétention RGPD des connexions réelles, une fois par jour : purge de la zone de transit au-delà de 365 jours,
// destruction cryptographique des secrets terminés depuis plus de 90 jours. Protégé par CRON_SECRET ; compteurs seulement.
export async function GET(req: Request, _context?: unknown, deps: { db: PrismaClient } = { db: prisma }) {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized
  const headers = { "Cache-Control": "private, no-store" }
  try {
    const summary = await runConnectorRetention(deps.db)
    // Preuve d'exécution quotidienne dans les journaux : compteurs seulement, aucune donnée.
    console.info("[connecteurs][retention] terminé", {
      stagedPurged: summary.stagedPurged,
      credentialsDestroyed: summary.credentialsDestroyed,
    })
    return NextResponse.json(summary, { headers })
  } catch (error) {
    console.error("[connecteurs][retention] échec", { name: error instanceof Error ? error.name : typeof error })
    return NextResponse.json({ code: "SERVER_ERROR" }, { status: 500, headers })
  }
}
