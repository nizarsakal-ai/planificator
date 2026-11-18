import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { isVehiclesV3Enabled } from "@/lib/vehicules/v3/v3-feature-flag"
import { runTourKmAutoRefresh, type AutoKmDeps } from "@/lib/vehicules/v3/tour-km-auto-service"

export const maxDuration = 60

// Km estimés automatiques des tournées à venir ou en cours : recalcul de nuit quand les étapes, les dates,
// le planning de l'équipe ou le logement Booking ont changé. Protégé par CRON_SECRET ; inactif sans V3.
export async function GET(req: Request, _context?: unknown, deps: AutoKmDeps = { db: prisma }) {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized
  const headers = { "Cache-Control": "private, no-store" }
  if (!isVehiclesV3Enabled()) return NextResponse.json({ code: "FEATURE_DISABLED" }, { status: 404, headers })
  try {
    const summary = await runTourKmAutoRefresh({ ...deps, budgetMs: 45_000 })
    return NextResponse.json(summary, { headers })
  } catch (error) {
    console.error("[vehicle-tours][auto-km] run failed", { name: error instanceof Error ? error.name : typeof error })
    return NextResponse.json({ code: "SERVER_ERROR" }, { status: 500, headers })
  }
}
