// IA-1 : point d'accès du copilote (POST JSON). Lecture seule.
// Drapeau + société cible (sinon 404) ; session obligatoire (401) ; ADMIN ou SUPER_ADMIN (403) ; corps JSON uniquement
// (415, protège des formulaires d'un autre site) ; quota quotidien par société (429). Le companyId vient de la session.
// Journal d'échec : phase, code et outils appelés, jamais la question ni la réponse.
import { NextResponse } from "next/server"
import { APIError } from "@anthropic-ai/sdk"
import type { Session } from "next-auth"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { createAnthropicExtractionClient, mapAnthropicSdkError } from "@/lib/acquisition/extraction/anthropic-extraction.client"
import { copilotConfig, isCopilotActionsEnabled, isCopilotExpertEnabled } from "@/lib/copilot/copilot-config"
import { isAdminRole, isCopilotRoleAllowed, resolveRoleContext } from "@/lib/copilot/copilot-roles"
import { proposalSecret } from "@/lib/copilot/copilot-proposal"
import { isBillingCompleteEnabled } from "@/lib/billing/billing-feature-flag"
import { isAutomationsEnabled } from "@/lib/automation/automation-feature-flag"
import { isCrmEnabled } from "@/lib/crm/crm-feature-flag"
import { reserveCopilotRequest } from "@/lib/copilot/copilot-quota"
import { parisToday } from "@/lib/copilot/copilot-date"
import { buildSystemPrompt, CopilotEmptyError, CopilotInputError, parseHistory, parseImage, parsePage, runCopilot } from "@/lib/copilot/copilot.core"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })


export async function POST(request: Request): Promise<Response> {
  let session: Session | null
  try { session = await auth() } catch { session = null }
  const user = session?.user
  const config = copilotConfig(user?.companyId)
  if (!config) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  if (!user?.id || !user.companyId) return json({ error: "Connexion requise." }, 401)
  if (!isCopilotRoleAllowed(user.role)) return json({ error: "L'assistant n'est pas encore ouvert à votre rôle." }, 403)
  const role = user.role
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Format refusé." }, 415)

  let history, page, image
  try {
    const body = (await request.json()) as { messages?: unknown; page?: unknown; image?: unknown }
    history = parseHistory(body.messages)
    page = parsePage(body.page)
    image = parseImage(body.image)
  } catch (error) {
    return json({ error: error instanceof CopilotInputError ? error.message : "Requête invalide." }, 400)
  }

  let phase: "quota" | "model" = "quota"
  try {
    const allowed = await reserveCopilotRequest(prisma, { companyId: user.companyId, actorId: user.id, dailyLimit: config.dailyLimit })
    if (!allowed) return json({ error: "La limite quotidienne de questions est atteinte. Elle se renouvelle demain." }, 429)

    const company = await prisma.company.findUnique({ where: { id: user.companyId }, select: { name: true } })
    const todayStr = parisToday()
    const today = new Date(`${todayStr}T00:00:00.000Z`)
    const admin = isAdminRole(role)
    const roleCtx = await resolveRoleContext(prisma, { id: user.id, companyId: user.companyId, role, email: user.email })
    const secret = admin && isCopilotActionsEnabled() ? proposalSecret() : null
    const actions = secret ? { companyId: user.companyId, userId: user.id, secret, billingEnabled: isBillingCompleteEnabled(), automationsEnabled: isAutomationsEnabled(), crmEnabled: isCrmEnabled(), today } : undefined
    const companyName = company?.name ?? "votre société"
    const companyId = user.companyId
    const actorId = user.id
    const expert = admin && isCopilotExpertEnabled()
      ? { companyName, todayStr, reserve: () => reserveCopilotRequest(prisma, { companyId, actorId, dailyLimit: config.dailyLimit }) }
      : undefined
    phase = "model"
    const result = await runCopilot(createAnthropicExtractionClient(config.apiKey), prisma, {
      history,
      companyId,
      today,
      image,
      actions,
      role: roleCtx,
      expert,
      system: buildSystemPrompt({ userName: user.name ?? "l'utilisateur", companyName, today: todayStr, page, actions: !!actions, role, expert: !!expert }),
    })
    return json({ reply: result.text, proposals: result.proposals })
  } catch (error) {
    const code = phase !== "model" ? "PERSISTENCE"
      : error instanceof CopilotEmptyError ? error.causeCode
      : mapAnthropicSdkError(error).kind
    console.warn("copilot_failed", {
      phase, code,
      ...(phase === "model" && error instanceof APIError && typeof error.status === "number" ? { status: error.status } : {}),
    })
    const text = code === "RATE_LIMIT" ? "L'assistant est très sollicité : réessayez dans une minute."
      : code === "REFUSAL" ? "L'assistant ne peut pas répondre à cette demande."
      : "L'assistant est indisponible pour le moment."
    return json({ error: text }, code === "RATE_LIMIT" ? 429 : 503)
  }
}
