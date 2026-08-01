/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Hook shadow post-legacy — admission budget + await project (pas d’annulation).
 */

import type { CanonicalMailMessage } from "@/lib/acquisition/connector/connector.types"
import { mapCanonicalMailToShadowDto } from "@/lib/acquisition/connector/mail-shadow-dto.mapper"
import {
  getMailShadowRunBudgetMs,
  isMailShadowActiveForCompany,
} from "@/lib/integration/flags/platform-flags"
import { MailShadowBridgeService } from "@/lib/integration/connectors/mail-bridge/mail-shadow-bridge.service"
import type { MailShadowBridgePort } from "@/lib/integration/connectors/mail-bridge/mail-shadow-bridge.port"
import {
  createMailShadowRunStats,
  type MailShadowRunStats,
} from "@/lib/integration/connectors/mail-bridge/mail-shadow-run-stats"
import { resolveMailShadowConnectionOnce } from "@/lib/acquisition/connector/mail-shadow-connection.once"
import {
  logMailShadow,
  logMailShadowError,
} from "@/lib/integration/connectors/mail-bridge/mail-shadow-log"

export type MailShadowRunContext = {
  connectionId: string
  deadlineAtMs: number
  stats: MailShadowRunStats
  bridge: MailShadowBridgePort
}

/**
 * Prépare le contexte shadow une fois / company / run.
 * null si flags OFF ou connection absente/ambiguë.
 */
export async function prepareMailShadowRun(
  companyId: string,
  options?: {
    env?: NodeJS.ProcessEnv
    nowMs?: number
    bridge?: MailShadowBridgePort
  }
): Promise<MailShadowRunContext | null> {
  const env = options?.env ?? process.env
  if (!isMailShadowActiveForCompany(companyId, env)) {
    return null
  }

  const stats = createMailShadowRunStats()
  const resolved = await resolveMailShadowConnectionOnce(companyId, stats)
  if (!resolved.ok) {
    return null
  }

  const nowMs = options?.nowMs ?? Date.now()
  const budgetMs = getMailShadowRunBudgetMs(env)

  return {
    connectionId: resolved.connectionId,
    deadlineAtMs: nowMs + budgetMs,
    stats,
    bridge: options?.bridge ?? new MailShadowBridgeService(),
  }
}

/**
 * Après traitement legacy d’un message : admission puis project awaité.
 * Ne throw jamais vers le caller métier.
 */
export async function projectMailShadowAfterLegacy(
  message: CanonicalMailMessage,
  companyId: string,
  ctx: MailShadowRunContext,
  nowMs: () => number = Date.now
): Promise<void> {
  try {
    if (nowMs() >= ctx.deadlineAtMs) {
      ctx.stats.skippedBudget++
      return
    }

    const mapped = mapCanonicalMailToShadowDto(message, {
      companyId,
      connectionId: ctx.connectionId,
    })
    if (!mapped.ok) {
      ctx.stats.shadowErrors++
      logMailShadow("warn", "mail_shadow_dto_map_failed", {
        companyId,
        connectionId: ctx.connectionId,
        outcome: "dto_map_failed",
        errorCode: mapped.errorCode,
      })
      return
    }

    await ctx.bridge.project(mapped.dto, { stats: ctx.stats })
  } catch (error) {
    ctx.stats.shadowErrors++
    logMailShadowError(
      "mail_shadow_hook_error",
      { companyId, connectionId: ctx.connectionId, errorCode: "hook_error" },
      error
    )
  }
}
