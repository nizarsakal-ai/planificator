/**
 * Assistant IA, étape 2 : gardes serveur DISTINCTES des deux sources des onglets. Ne jamais importer côté client.
 * - `rulesSourceGuard` : la garde EXACTE de la route /assistant (lot F), réutilisée telle quelle.
 * - `copilotAdminGuard` : copilote configuré pour la société de session et rôle ADMIN/SUPER_ADMIN (le copilote est ouvert à
 *   d'autres rôles pour la discussion, mais son journal et ses onglets d'administration ne le sont pas).
 */
import type { Session } from "next-auth"
import { auth } from "@/auth"
import { assistantDenialStatus, resolveAssistantAccess } from "@/lib/assistant/access"
import { resolveAssistantAccessCore } from "@/lib/assistant/access"
import { copilotConfig, isCopilotRole } from "@/lib/copilot/copilot-config"
import type { SourceGuard } from "@/lib/copilot/copilot-tabs"

/** Garde du lot F, identique à celle de la page /assistant. */
export async function rulesSourceGuard(): Promise<SourceGuard> {
  try {
    const r = await resolveAssistantAccess()
    return r.ok ? { ok: true, companyId: r.context.companyId } : { ok: false, status: assistantDenialStatus(r.reason) }
  } catch {
    return { ok: false, status: 404 }
  }
}

/** Logique pure de la garde d'administration du copilote (testable). */
export function copilotAdminGuardCore(user: { id?: string | null; role?: string | null; companyId?: string | null } | null | undefined, env: Record<string, string | undefined> = process.env): SourceGuard {
  if (!copilotConfig(user?.companyId, env)) return { ok: false, status: 404 }
  if (!user?.id || !user.companyId) return { ok: false, status: 401 }
  if (!isCopilotRole(user.role)) return { ok: false, status: 403 }
  return { ok: true, companyId: user.companyId }
}

export async function copilotAdminGuard(): Promise<SourceGuard> {
  let session: Session | null
  try { session = await auth() } catch { session = null }
  return copilotAdminGuardCore(session?.user)
}

// Réexport pour les tests de la garde du lot F (logique pure inchangée).
export { resolveAssistantAccessCore }
