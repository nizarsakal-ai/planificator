/**
 * PLAN-ACQ-V2-001 — Service orchestrateur (étapes injectables).
 * Par défaut : runners non câblés (pas de faux SUCCESS).
 */

import {
  ACQUISITION_ORCHESTRATOR_LEASE_KEY,
  getAcquisitionOrchestratorConfig,
  type AcquisitionOrchestratorConfig,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import { resolveAcquisitionOrchestratorCronGate } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-gate"
import type { AcquisitionOrchestratorLeaseRepositoryPort } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"
import {
  ORCHESTRATOR_STEP_KEYS,
  type AcquisitionOrchestratorRunResult,
  type AcquisitionOrchestratorStepRunners,
  type OrchestratorStepKey,
  type OrchestratorStepResult,
  type OrchestratorStepRunner,
  type OrchestratorStepRunnerResult,
  type OrchestratorStepsMap,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"

const LOG_PREFIX = "[acquisition-orchestrator]"

const STEP_ORDER: OrchestratorStepKey[] = [...ORCHESTRATOR_STEP_KEYS]

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

/** Stubs SUCCESS — uniquement si ALLOW_STUBS=true (tests/debug). */
export function createStubStepRunner(
  step: OrchestratorStepKey
): OrchestratorStepRunner {
  return async () => ({
    status: "SUCCESS",
    result: { stub: true, step },
  })
}

export function createDefaultStubStepRunners(): AcquisitionOrchestratorStepRunners {
  return {
    gmailSync: createStubStepRunner("gmailSync"),
    attachmentRecovery: createStubStepRunner("attachmentRecovery"),
    attachmentDownload: createStubStepRunner("attachmentDownload"),
    contentFetch: createStubStepRunner("contentFetch"),
    extraction: createStubStepRunner("extraction"),
  }
}

/** Runners par défaut production tant que Lot B non câblé — pas de faux SUCCESS. */
export function createUnwiredStepRunners(): AcquisitionOrchestratorStepRunners {
  const fail: OrchestratorStepRunner = async () => ({
    status: "FAILED",
    error: {
      code: "WORKERS_NOT_WIRED",
      message: "Workers orchestrateur non branchés",
    },
    skipReason: "WORKERS_NOT_WIRED",
  })
  return {
    gmailSync: fail,
    attachmentRecovery: fail,
    attachmentDownload: fail,
    contentFetch: fail,
    extraction: fail,
  }
}

function emptySteps(status: OrchestratorStepResult["status"] = "NOT_RUN"): OrchestratorStepsMap {
  const steps = {} as OrchestratorStepsMap
  for (const key of STEP_ORDER) {
    steps[key] = { status, durationMs: 0 }
  }
  return steps
}

function publicStepError(_error: unknown): { code: string; message: string } {
  void _error
  return {
    code: "STEP_UNEXPECTED_FAILURE",
    message: "Échec inattendu de l’étape",
  }
}

export function aggregateOrchestratorStatus(
  steps: OrchestratorStepsMap,
  opts?: { leaseReleaseFailed?: boolean }
): AcquisitionOrchestratorRunResult["status"] {
  const values = STEP_ORDER.map((k) => steps[k])
  const hasFailed = values.some((s) => s.status === "FAILED")
  const hasPartial = values.some((s) => s.status === "PARTIAL")
  const hasSuccess = values.some((s) => s.status === "SUCCESS")
  const hasBudgetSkip = values.some((s) => s.skipReason === "BUDGET_EXHAUSTED")
  const hasStolen = values.some((s) => s.skipReason === "LEASE_STOLEN")
  const allSkippedOrNotRun = values.every(
    (s) => s.status === "SKIPPED" || s.status === "NOT_RUN"
  )

  if (opts?.leaseReleaseFailed) return "PARTIAL"
  if (hasStolen) return "PARTIAL"
  if (hasFailed && !hasSuccess && !hasPartial) return "FAILED"
  if (hasFailed || hasPartial || hasBudgetSkip) return "PARTIAL"
  if (values.every((s) => s.status === "SUCCESS")) return "SUCCESS"
  if (hasSuccess) return "SUCCESS"
  if (allSkippedOrNotRun) return "SKIPPED"
  return "PARTIAL"
}

export interface RunAcquisitionOrchestratorInput {
  runId: string
  leaseRepository: AcquisitionOrchestratorLeaseRepositoryPort
  steps?: AcquisitionOrchestratorStepRunners
  config?: AcquisitionOrchestratorConfig
  now?: () => Date
  log?: (event: string, payload?: Record<string, unknown>) => void
  resolveGate?: () => ReturnType<typeof resolveAcquisitionOrchestratorCronGate>
}

export async function runAcquisitionOrchestrator(
  input: RunAcquisitionOrchestratorInput
): Promise<AcquisitionOrchestratorRunResult> {
  const clock = input.now ?? (() => new Date())
  const log = input.log ?? defaultLog
  const config = input.config ?? getAcquisitionOrchestratorConfig()
  const runners = input.steps ?? createUnwiredStepRunners()
  const resolveGate = input.resolveGate ?? resolveAcquisitionOrchestratorCronGate

  const startedAt = clock()
  const runId = input.runId

  log("ORCHESTRATOR_START", { runId, at: startedAt.toISOString() })

  const gate = resolveGate()
  if (!gate.allowed) {
    const finishedAt = clock()
    const skipReason = gate.skipReason ?? "CRON_DISABLED"
    const result: AcquisitionOrchestratorRunResult = {
      status: "SKIPPED",
      skipReason,
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      steps: emptySteps("NOT_RUN"),
    }
    log("ORCHESTRATOR_FINISHED", {
      runId,
      status: result.status,
      skipReason,
      durationMs: result.durationMs,
    })
    return result
  }

  const acquire = await input.leaseRepository.acquire({
    key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
    ownerRunId: runId,
    leaseTtlMs: config.leaseTtlMs,
  })

  if (acquire.outcome === "ALREADY_RUNNING") {
    const finishedAt = clock()
    const result: AcquisitionOrchestratorRunResult = {
      status: "SKIPPED",
      skipReason: "ALREADY_RUNNING",
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      steps: emptySteps("NOT_RUN"),
    }
    log("ORCHESTRATOR_FINISHED", {
      runId,
      status: result.status,
      skipReason: "ALREADY_RUNNING",
      durationMs: result.durationMs,
    })
    return result
  }

  const steps = emptySteps("NOT_RUN")
  let budgetExhausted = false
  let leaseStolen = false
  let leaseReleaseFailed = false

  try {
    for (const key of STEP_ORDER) {
      if (leaseStolen) {
        steps[key] = {
          status: "NOT_RUN",
          durationMs: 0,
          skipReason: "LEASE_STOLEN",
        }
        continue
      }

      const ownership = await input.leaseRepository.assertOwned({
        key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
        ownerRunId: runId,
      })
      if (ownership.outcome !== "OWNED") {
        leaseStolen = true
        steps[key] = {
          status: "FAILED",
          durationMs: 0,
          skipReason: "LEASE_STOLEN",
          error: {
            code: "LEASE_STOLEN",
            message: "Lease reprise par une autre exécution",
          },
        }
        log("ORCHESTRATOR_LEASE_STOLEN", { runId, step: key })
        continue
      }

      const now = clock()
      const elapsed = now.getTime() - startedAt.getTime()
      const remainingMs = config.maxDurationMs - elapsed - config.safetyMarginMs

      if (budgetExhausted || remainingMs <= 0) {
        budgetExhausted = true
        steps[key] = {
          status: "NOT_RUN",
          durationMs: 0,
          skipReason: "BUDGET_EXHAUSTED",
        }
        log("ORCHESTRATOR_STEP_SKIPPED", {
          runId,
          step: key,
          skipReason: "BUDGET_EXHAUSTED",
          remainingMs,
        })
        continue
      }

      const stepStarted = clock()
      log("ORCHESTRATOR_STEP_START", { runId, step: key, remainingMs })

      let runnerResult: OrchestratorStepRunnerResult
      try {
        runnerResult = await runners[key]({ runId, remainingMs })
      } catch (error) {
        const stepFinished = clock()
        steps[key] = {
          status: "FAILED",
          durationMs: stepFinished.getTime() - stepStarted.getTime(),
          error: publicStepError(error),
        }
        log("ORCHESTRATOR_STEP_FAILED", {
          runId,
          step: key,
          code: "STEP_UNEXPECTED_FAILURE",
          durationMs: steps[key].durationMs,
        })
        continue
      }

      const stepFinished = clock()
      const durationMs = stepFinished.getTime() - stepStarted.getTime()
      const safeResult =
        runnerResult.result !== undefined &&
        typeof runnerResult.result === "object" &&
        runnerResult.result !== null &&
        !("accessToken" in (runnerResult.result as object)) &&
        !("authorization" in (runnerResult.result as object))
          ? runnerResult.result
          : runnerResult.result !== undefined &&
              typeof runnerResult.result !== "object"
            ? runnerResult.result
            : runnerResult.result !== undefined
              ? { ok: true }
              : undefined

      steps[key] = {
        status: runnerResult.status,
        durationMs,
        ...(runnerResult.skipReason ? { skipReason: runnerResult.skipReason } : {}),
        ...(runnerResult.error ? { error: runnerResult.error } : {}),
        ...(safeResult !== undefined ? { result: safeResult } : {}),
      }
      log("ORCHESTRATOR_STEP_FINISHED", {
        runId,
        step: key,
        status: runnerResult.status,
        durationMs,
      })
    }
  } finally {
    try {
      const released = await input.leaseRepository.release({
        key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
        ownerRunId: runId,
      })
      if (released.outcome !== "RELEASED" && !leaseStolen) {
        leaseReleaseFailed = true
        log("ORCHESTRATOR_LEASE_RELEASE_UNEXPECTED", {
          runId,
          outcome: released.outcome,
        })
      }
    } catch {
      leaseReleaseFailed = true
      log("ORCHESTRATOR_LEASE_RELEASE_FAILED", { runId })
    }
  }

  const finishedAt = clock()
  const status = aggregateOrchestratorStatus(steps, { leaseReleaseFailed })
  const result: AcquisitionOrchestratorRunResult = {
    status,
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    steps,
    ...(leaseReleaseFailed ? { leaseReleaseFailed: true } : {}),
  }
  log("ORCHESTRATOR_FINISHED", {
    runId,
    status: result.status,
    durationMs: result.durationMs,
  })
  return result
}
