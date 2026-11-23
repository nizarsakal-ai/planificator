// IA-2 : confirmation d'une proposition du copilote (POST JSON { token }). Même garde que le copilote (404 / 401 / 403 /
// 415), plus le drapeau COPILOT_ACTIONS_ENABLED. Le jeton doit être signé, non expiré, émis pour CET utilisateur et
// CETTE société, et jamais confirmé auparavant. L'action passe ensuite par la fonction de l'interface correspondante.
import { NextResponse } from "next/server"
import type { Session } from "next-auth"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { copilotConfig, isCopilotActionsEnabled, isCopilotRole } from "@/lib/copilot/copilot-config"
import { proposalSecret, verifyProposal } from "@/lib/copilot/copilot-proposal"
import { executeProposal, releaseProposal, reserveProposal } from "@/lib/copilot/copilot-execute"

export const dynamic = "force-dynamic"

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })

const REASON_TEXT = {
  INVALID: "Proposition invalide.",
  EXPIRED: "Cette proposition a expiré (15 minutes). Redemandez-la à l'assistant.",
  OTHER_USER: "Cette proposition ne vous est pas destinée.",
} as const

export async function POST(request: Request): Promise<Response> {
  let session: Session | null
  try { session = await auth() } catch { session = null }
  const user = session?.user
  const secret = proposalSecret()
  if (!copilotConfig(user?.companyId) || !isCopilotActionsEnabled() || !secret) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } })
  if (!user?.id || !user.companyId) return json({ error: "Connexion requise." }, 401)
  if (!isCopilotRole(user.role)) return json({ error: "Réservé à l'administration." }, 403)
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "Format refusé." }, 415)

  let token: unknown
  try { token = ((await request.json()) as { token?: unknown }).token } catch { return json({ error: "Requête invalide." }, 400) }
  const ctx = { companyId: user.companyId, userId: user.id }
  const verified = verifyProposal(token, ctx, secret)
  if (!verified.ok) return json({ error: REASON_TEXT[verified.reason] }, verified.reason === "OTHER_USER" ? 403 : 400)

  let reserved = false
  try {
    reserved = await reserveProposal(prisma, { companyId: ctx.companyId, actorId: ctx.userId, nonce: verified.nonce, kind: verified.payload.kind })
    if (!reserved) return json({ error: "Cette proposition a déjà été confirmée." }, 409)
    // Chargement à la demande : ces modules ouvrent des clients (courriel…) qui ne doivent pas s'initialiser à la compilation.
    const [{ createTask }, { affecterEquipe }, { createQuoteAction }] = await Promise.all([
      import("@/lib/actions/task.actions"), import("@/lib/actions/chantier.actions"), import("@/lib/actions/quote.actions"),
    ])
    const result = await executeProposal(verified.payload, { createTask, assignTeam: affecterEquipe, createQuote: createQuoteAction })
    if (!result.ok) {
      await releaseProposal(prisma, { companyId: ctx.companyId, nonce: verified.nonce })
      return json({ error: result.error }, 422)
    }
    return json(result)
  } catch (error) {
    if (reserved) await releaseProposal(prisma, { companyId: ctx.companyId, nonce: verified.nonce }).catch(() => undefined)
    console.warn("copilot_action_failed", { kind: verified.payload.kind, code: error instanceof Error ? error.name : "UNKNOWN" })
    return json({ error: "L'action n'a pas pu être faite. Réessayez." }, 503)
  }
}
