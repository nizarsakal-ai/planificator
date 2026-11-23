// IA-3 : briefing du jour (GET). Même garde que le copilote (404 / 401 / 403). Calcul déterministe : aucun appel à l'IA,
// donc hors quota. Le companyId vient de la session ; jamais mis en cache.
import { NextResponse } from "next/server"
import type { Session } from "next-auth"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { copilotConfig, isCopilotRole } from "@/lib/copilot/copilot-config"
import { badgeCount, buildBriefing } from "@/lib/copilot/copilot-briefing"
import { parisToday } from "@/lib/copilot/copilot-date"

export const dynamic = "force-dynamic"

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })

export async function GET(): Promise<Response> {
  let session: Session | null
  try { session = await auth() } catch { session = null }
  const user = session?.user
  if (!copilotConfig(user?.companyId)) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  if (!user?.id || !user.companyId) return json({ error: "Connexion requise." }, 401)
  if (!isCopilotRole(user.role)) return json({ error: "Réservé à l'administration." }, 403)
  try {
    const briefing = await buildBriefing(prisma, user.companyId, new Date(`${parisToday()}T00:00:00.000Z`))
    return json({ ...briefing, badge: badgeCount(briefing) })
  } catch (error) {
    console.warn("copilot_briefing_failed", { code: error instanceof Error ? error.name : "UNKNOWN" })
    return json({ error: "Briefing indisponible pour le moment." }, 503)
  }
}
