/**
 * Harness Preview Staging — runner auto-decision CIBLÉ (un seul draft), fail-closed.
 *
 * Étape préparatoire : NON câblé à une route. Le runner ne manipule JAMAIS de capability,
 * de lease ni de fence : il valide surface / gate / rôle / tenant / cible env puis délègue au
 * wiring orchestrateur (runTargetedAutoDecisionUnderOrchestratorLease), seul endroit où la
 * capability AUTO est créée, après acquisition de la lease canonique.
 *
 * Hard-stop : TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED = false → refus AVANT toute lease,
 * toute lecture DB et tout worker. Aucune mutation réelle atteignable.
 */

import { auth } from "@/auth"
import {
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  isHarnessSurfaceAllowed,
} from "@/lib/acquisition/capabilities/targeted-staging-validation-preflight.handler"
import {
  runTargetedAutoDecisionUnderOrchestratorLease,
  type TargetedAutoDecisionLeaseRunResult,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import {
  TARGETED_AUTO_DECISION_COMPANY_ENV as COMPANY_ENV,
  TARGETED_AUTO_DECISION_DRAFT_ENV as DRAFT_ENV,
  TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED,
} from "@/lib/acquisition/orchestrator/targeted-staging-auto-decision-selection"

/** Gate dédié, distinct du flag CHECK du preflight. Exactement "true" requis. */
export const TARGETED_AUTO_DECISION_RUN_GATE = "TARGETED_STAGING_AUTO_DECISION_RUN_ENABLED"

export type TargetedAutoDecisionRunnerDeps = {
  env?: Record<string, string | undefined>
  auth?: typeof auth
}

export type TargetedAutoDecisionRunOutcome =
  | { ok: false; code: string }
  | {
      ok: true
      workerStatus: string
      skipReason: string | null
      stats: Extract<TargetedAutoDecisionLeaseRunResult, { outcome: "WORKER_FINISHED" }>["worker"]["stats"]
    }

function refused(code: string): TargetedAutoDecisionRunOutcome {
  return { ok: false, code }
}

/**
 * Exécution ciblée fail-closed. Chaque refus intervient avant toute lease, toute lecture DB
 * et tout appel worker.
 */
export async function runTargetedStagingAutoDecision(
  deps: TargetedAutoDecisionRunnerDeps = {}
): Promise<TargetedAutoDecisionRunOutcome> {
  const env = deps.env ?? process.env

  if (!isHarnessSurfaceAllowed(env as NodeJS.ProcessEnv)) return refused("HARNESS_SURFACE_FORBIDDEN")
  if (env[TARGETED_AUTO_DECISION_RUN_GATE] !== "true") return refused("TARGETED_RUN_DISABLED")

  const session = await (deps.auth ?? auth)()
  if (!session?.user) return refused("UNAUTHORIZED")
  if (!["ADMIN", "SUPER_ADMIN"].includes(session.user.role)) return refused("FORBIDDEN")

  // Cible : uniquement les variables serveur du harness (aucun paramètre de cible).
  const companyId = (env[COMPANY_ENV] ?? "").trim()
  const draftId = (env[DRAFT_ENV] ?? "").trim()
  if (!companyId || !draftId) return refused("HARNESS_TARGET_UNSET")
  if (draftId === FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID) return refused("FORBIDDEN_DRAFT")
  if (!session.user.companyId || session.user.companyId !== companyId) return refused("TENANT_MISMATCH")

  // Étape préparatoire : aucune mutation réelle. Constante, non injectable.
  if (!TARGETED_AUTO_DECISION_RUN_MUTATION_ARMED) return refused("TARGETED_RUN_NOT_ARMED")

  const run = await runTargetedAutoDecisionUnderOrchestratorLease({
    target: { companyId, draftId },
  })
  // Fail-closed : toute libération de lease non confirmée invalide le run.
  if ("release" in run && run.release !== "RELEASED") return refused("LEASE_RELEASE_NOT_CONFIRMED")
  if (run.outcome !== "WORKER_FINISHED") return refused(run.outcome)
  return {
    ok: true,
    workerStatus: run.worker.status,
    skipReason: run.worker.skipReason ?? null,
    stats: run.worker.stats,
  }
}
