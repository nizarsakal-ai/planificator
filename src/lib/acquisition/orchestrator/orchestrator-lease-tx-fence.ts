/**
 * PLAN-ACQ-AGENTS-LOT-3F — Fence lease orchestrateur (SELECT FOR UPDATE).
 * Implémentation côté orchestrateur ; non importée par le domaine conversion.
 */

import type { Prisma } from "@prisma/client"
import type { ConversionTransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"

/**
 * Fence authentique : verrouille la ligne lease tant que la TX conversion est ouverte.
 * N’acquiert / ne renouvelle jamais une lease.
 */
export function createOrchestratorLeaseTransactionalFence(input: {
  leaseKey: string
  ownerRunId: string
}): ConversionTransactionalOwnershipFence {
  const leaseKey = input.leaseKey
  const ownerRunId = input.ownerRunId
  return {
    async assertOwnedAndLock(tx: Prisma.TransactionClient) {
      const rows = await tx.$queryRaw<Array<{ key: string }>>`
        SELECT "key"
        FROM "acquisition_orchestrator_leases"
        WHERE "key" = ${leaseKey}
          AND "ownerRunId" = ${ownerRunId}
          AND "leaseExpiresAt" IS NOT NULL
          AND "leaseExpiresAt" >= clock_timestamp()
        FOR UPDATE
      `
      return rows.length > 0 ? "OWNED" : "NOT_OWNED"
    },
  }
}

/** Tests uniquement — même implémentation, nom explicite. */
export function createOrchestratorLeaseTransactionalFenceForTests(input: {
  leaseKey: string
  ownerRunId: string
}): ConversionTransactionalOwnershipFence {
  return createOrchestratorLeaseTransactionalFence(input)
}
