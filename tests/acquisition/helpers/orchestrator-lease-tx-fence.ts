/**
 * Helper tests LOT-3G — fence lease FOR UPDATE (hors exports production ForTests).
 * Délègue à l’implémentation production unique (pas de SQL dupliqué).
 */
import { createOrchestratorLeaseTransactionalFence } from "@/lib/acquisition/orchestrator/orchestrator-lease-tx-fence"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"

export function createTestOrchestratorLeaseTransactionalFence(input: {
  leaseKey: string
  ownerRunId: string
}): TransactionalOwnershipFence {
  return createOrchestratorLeaseTransactionalFence(input)
}
