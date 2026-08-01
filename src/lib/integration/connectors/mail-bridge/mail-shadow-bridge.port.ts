/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Port Mail Shadow Bridge.
 */

import type { MailShadowInputDto } from "@/lib/integration/connectors/mail-bridge/mail-shadow-input.dto"
import type { MailShadowRunStats } from "@/lib/integration/connectors/mail-bridge/mail-shadow-run-stats"

export type MailShadowBridgeContext = {
  stats: MailShadowRunStats
}

export interface MailShadowBridgePort {
  project(dto: unknown, ctx: MailShadowBridgeContext): Promise<void>
}

export type { MailShadowInputDto }
