/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1C
 * Bootstrap ops IntegrationConnection mail legacy — pas d’UI, pas de secrets Platform.
 */

import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { MAIL_SHADOW_CONNECTOR_TYPE } from "@/lib/integration/flags/platform-flag-names"
import { IntegrationConnectionRepository } from "@/lib/integration/persistence/integration-connection.repository"
import { CONNECTION_STATUSES } from "@/lib/integration/types/connection-status"
import { SECRET_BACKENDS } from "@/lib/integration/types/secret-backend"
import type { IntegrationConnection } from "@/lib/integration/contracts/integration-connection"

export type BootstrapLegacyMailConnectionInput = {
  companyId: string
  displayName?: string
  /** Si true (défaut) et une Connection éligible existe → la retourne. */
  returnExisting?: boolean
}

export type BootstrapLegacyMailConnectionResult =
  | { status: "created"; connection: IntegrationConnection }
  | { status: "existing"; connection: IntegrationConnection }
  | { status: "ambiguous"; connections: IntegrationConnection[] }

function isEligibleLegacyMail(c: IntegrationConnection): boolean {
  return (
    c.connectorType === MAIL_SHADOW_CONNECTOR_TYPE &&
    c.secretBackend === SECRET_BACKENDS.LEGACY_GMAIL
  )
}

/**
 * Crée une IntegrationConnection pour le bridge mail shadow.
 * secretBackend = LEGACY_GMAIL ; connectorType = platform.mail.legacy.
 * MUST NOT résoudre de secret Platform.
 */
export async function bootstrapLegacyMailConnection(
  input: BootstrapLegacyMailConnectionInput,
  db: PrismaClient = prisma
): Promise<BootstrapLegacyMailConnectionResult> {
  if (!input.companyId) {
    throw new Error("companyId requis")
  }

  const repo = new IntegrationConnectionRepository(db)
  const listed = await repo.listByCompany(input.companyId)
  const existing = listed.filter(isEligibleLegacyMail)

  if (existing.length > 1) {
    return { status: "ambiguous", connections: existing }
  }
  if (existing.length === 1) {
    if (input.returnExisting === false) {
      return { status: "ambiguous", connections: existing }
    }
    return { status: "existing", connection: existing[0]! }
  }

  const connection = await repo.create({
    companyId: input.companyId,
    connectorType: MAIL_SHADOW_CONNECTOR_TYPE,
    displayName: input.displayName ?? "Mail legacy shadow",
    status: CONNECTION_STATUSES.ACTIVE,
    secretBackend: SECRET_BACKENDS.LEGACY_GMAIL,
    config: { channel: "mail_shadow" },
  })

  return { status: "created", connection }
}
