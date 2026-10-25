import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { isVehiclesV3Enabled } from "@/lib/vehicules/v3/v3-feature-flag"
import { runVehicleDocumentReminders, type ReminderRunDeps } from "@/lib/vehicules/v3/document-service"

// V3 Lot 1 — rappels internes dédupliqués des échéances documentaires.
// Protégé par CRON_SECRET ; inactif tant que V3 n'est pas activée. Planifié quotidiennement dans vercel.json.
export async function GET(req: Request, _context?: unknown, deps: ReminderRunDeps = { db: prisma }) {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized
  if (!isVehiclesV3Enabled()) return NextResponse.json({ code: "FEATURE_DISABLED" }, { status: 404, headers: { "Cache-Control": "private, no-store" } })
  try {
    const summary = await runVehicleDocumentReminders(deps)
    return NextResponse.json(summary, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    console.error("[vehicle-documents][reminders] run failed", { name: error instanceof Error ? error.name : typeof error })
    return NextResponse.json({ code: "SERVER_ERROR" }, { status: 500, headers: { "Cache-Control": "private, no-store" } })
  }
}
