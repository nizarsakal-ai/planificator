/**
 * PLAN-ACQ-012-4 — Ownership item-level générique (sans factory AUTO).
 * Absent = chemin unit cron. Erreur = fail-closed NOT_OWNED. Pas de reacquire.
 */

import {
  ACQUISITION_ORCHESTRATOR_LEASE_KEY,
  getAcquisitionOrchestratorConfig,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import type { AcquisitionOrchestratorLeaseRepositoryPort } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"

export type OrchestratorOwnershipState = "OWNED" | "NOT_OWNED"

/** Check item-level : présent uniquement sur le chemin orchestrateur. */
export type OrchestratorItemOwnershipCheck = () => Promise<OrchestratorOwnershipState>

/**
 * Heartbeat lease bas niveau : assertOwned puis renew obligatoire.
 * renew absent ou non OWNED → NOT_OWNED (fail-closed). Jamais d’acquire.
 * Ne minte pas de capability AUTO.
 */
export async function checkOrchestratorLeaseHeartbeat(input: {
  leaseRepository: AcquisitionOrchestratorLeaseRepositoryPort
  ownerRunId: string
}): Promise<OrchestratorOwnershipState> {
  try {
    const owned = await input.leaseRepository.assertOwned({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: input.ownerRunId,
    })
    if (owned.outcome !== "OWNED") return "NOT_OWNED"
    if (typeof input.leaseRepository.renew !== "function") return "NOT_OWNED"
    const renewed = await input.leaseRepository.renew({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: input.ownerRunId,
      leaseTtlMs: getAcquisitionOrchestratorConfig().leaseTtlMs,
    })
    return renewed.outcome === "OWNED" ? "OWNED" : "NOT_OWNED"
  } catch {
    return "NOT_OWNED"
  }
}

/**
 * Absent = chemin unit cron (pas de lease). Erreur ownership = NOT_OWNED (fail-closed).
 */
export async function isOrchestratorOwnershipValid(
  ensureOwnership: OrchestratorItemOwnershipCheck | undefined
): Promise<boolean> {
  if (!ensureOwnership) return true
  try {
    return (await ensureOwnership()) === "OWNED"
  } catch {
    return false
  }
}
