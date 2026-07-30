/**
 * Gate orchestrateur V2 — ordre : flag orchestrateur → master.
 */

import { isAcquisitionEnabled } from "@/lib/acquisition/acquisition-feature-flag"
import { isAcquisitionOrchestratorCronEnabled } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import type { AcquisitionOrchestratorSkipReason } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"

export function resolveAcquisitionOrchestratorCronGate(): {
  allowed: boolean
  skipReason?: AcquisitionOrchestratorSkipReason
} {
  if (!isAcquisitionOrchestratorCronEnabled()) {
    return { allowed: false, skipReason: "CRON_DISABLED" }
  }
  if (!isAcquisitionEnabled()) {
    return { allowed: false, skipReason: "MASTER_DISABLED" }
  }
  return { allowed: true }
}
