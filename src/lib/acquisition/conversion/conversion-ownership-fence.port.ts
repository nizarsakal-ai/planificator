/**
 * PLAN-ACQ-AGENTS-LOT-3F / LOT-3G — Port générique de fencing ownership transactionnel.
 * Le domaine métier ne connaît pas la lease orchestrateur.
 */

import type { Prisma } from "@prisma/client"

export type ConversionTxOwnershipState = "OWNED" | "NOT_OWNED"
export type TxOwnershipState = ConversionTxOwnershipState

/**
 * Preuve d’ownership dans le TransactionClient métier.
 * Doit verrouiller la ressource jusqu’au COMMIT/ROLLBACK (ex. SELECT FOR UPDATE).
 */
export type ConversionTransactionalOwnershipFence = {
  assertOwnedAndLock(
    tx: Prisma.TransactionClient
  ): Promise<ConversionTxOwnershipState>
}

/** Alias LOT-3G — review / cancellation / workers. */
export type TransactionalOwnershipFence = ConversionTransactionalOwnershipFence

export type ConvertImportDraftOptions = {
  transactionalOwnershipFence?: ConversionTransactionalOwnershipFence
}
