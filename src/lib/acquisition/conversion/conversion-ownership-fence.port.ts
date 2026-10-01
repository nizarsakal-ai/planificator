/**
 * PLAN-ACQ-AGENTS-LOT-3F / LOT-3G — Port générique de fencing ownership transactionnel.
 * Le domaine métier ne connaît pas la lease orchestrateur.
 */

import type { Prisma } from "@prisma/client"
import type { ConversionMasterGateExemption } from "@/lib/acquisition/conversion/conversion.types"

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
  /**
   * PLAN-ACQ-DETECTION-001-R8 — si présent (AUTO), revalide le hash source
   * courant dans la TX après fence, avant mutation.
   */
  requireSourceContentHash?: string
  /**
   * Port interne d'exemption du gate conversion (cf. ConversionMasterGateExemption).
   * Absent → comportement historique strict.
   */
  conversionMasterGateExemption?: ConversionMasterGateExemption
}
