/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Resolve IntegrationConnection une fois par company/run (côté Acquisition).
 */

import { IntegrationConnectionRepository } from "@/lib/integration/persistence/integration-connection.repository"
import { MAIL_SHADOW_CONNECTOR_TYPE } from "@/lib/integration/flags/platform-flag-names"
import { CONNECTION_STATUSES } from "@/lib/integration/types/connection-status"
import { SECRET_BACKENDS } from "@/lib/integration/types/secret-backend"
import type { IntegrationConnection } from "@/lib/integration/contracts/integration-connection"
import {
  logMailShadow,
} from "@/lib/integration/connectors/mail-bridge/mail-shadow-log"
import type { MailShadowRunStats } from "@/lib/integration/connectors/mail-bridge/mail-shadow-run-stats"

export type ResolveMailShadowConnectionResult =
  | { ok: true; connectionId: string; connectorType: string }
  | { ok: false; reason: "missing" | "ambiguous" | "not_eligible" }

function isEligible(c: IntegrationConnection): boolean {
  return (
    c.status === CONNECTION_STATUSES.ACTIVE &&
    c.secretBackend === SECRET_BACKENDS.LEGACY_GMAIL &&
    c.connectorType === MAIL_SHADOW_CONNECTOR_TYPE
  )
}

/**
 * Liste les Connections du tenant et retient l’unique éligible mail shadow.
 * 0 ou N>1 → not ok (pas d’auto-create).
 */
export async function resolveMailShadowConnectionOnce(
  companyId: string,
  stats: MailShadowRunStats,
  repo: IntegrationConnectionRepository = new IntegrationConnectionRepository()
): Promise<ResolveMailShadowConnectionResult> {
  const listed = await repo.listByCompany(companyId, {
    status: CONNECTION_STATUSES.ACTIVE,
  })
  const eligible = listed.filter(isEligible)

  if (eligible.length === 0) {
    if (stats.connectionMissingLogged === 0) {
      stats.connectionMissingLogged = 1
      logMailShadow("warn", "mail_shadow_connection_missing", {
        companyId,
        outcome: "connection_missing",
        errorCode: "connection_missing",
      })
    }
    return { ok: false, reason: "missing" }
  }

  if (eligible.length > 1) {
    if (stats.connectionMissingLogged === 0) {
      stats.connectionMissingLogged = 1
      logMailShadow("warn", "mail_shadow_connection_ambiguous", {
        companyId,
        outcome: "connection_missing",
        errorCode: "ambiguous",
      })
    }
    return { ok: false, reason: "ambiguous" }
  }

  const c = eligible[0]!
  return {
    ok: true,
    connectionId: c.id,
    connectorType: c.connectorType,
  }
}
