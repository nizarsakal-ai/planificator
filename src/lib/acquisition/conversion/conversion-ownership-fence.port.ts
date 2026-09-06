/**
 * PLAN-ACQ-AGENTS-LOT-3F — Port générique de fencing ownership transactionnel.
 * Le domaine conversion ne connaît pas la lease orchestrateur.
 */

import type { Prisma } from "@prisma/client"

export type ConversionTxOwnershipState = "OWNED" | "NOT_OWNED"

/**
 * Preuve d’ownership dans le TransactionClient de conversion.
 * Doit verrouiller la ressource jusqu’au COMMIT/ROLLBACK (ex. SELECT FOR UPDATE).
 */
export type ConversionTransactionalOwnershipFence = {
  assertOwnedAndLock(
    tx: Prisma.TransactionClient
  ): Promise<ConversionTxOwnershipState>
}

export type ConvertImportDraftOptions = {
  transactionalOwnershipFence?: ConversionTransactionalOwnershipFence
}
