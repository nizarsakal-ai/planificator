// Lot E Planificator V2 : passe d'exécution des automatisations (toutes les entreprises ayant une règle ACTIVE).
// Protégée par CRON_SECRET ; 404 tant que AUTOMATIONS_ENABLED n'est pas "true". La planification (vercel.json) n'est
// PAS ajoutée par ce lot : elle relève de l'activation, sur autorisation. Sans effet si aucune règle n'est approuvée.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import { isAutomationsEnabled } from "@/lib/automation/automation-feature-flag"
import { runAutomations } from "@/lib/automation/automation.service"

export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store" }

export async function GET(req: Request) {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized
  if (!isAutomationsEnabled()) return NextResponse.json({ code: "FEATURE_DISABLED" }, { status: 404, headers })
  try {
    const summary = await runAutomations(prisma)
    return NextResponse.json(summary, { headers })
  } catch (error) {
    console.error("[automations] passe en échec", { name: error instanceof Error ? error.name : typeof error })
    return NextResponse.json({ code: "SERVER_ERROR" }, { status: 500, headers })
  }
}
