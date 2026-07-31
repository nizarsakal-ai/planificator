import { NextResponse } from "next/server"
import { assertCronBearerAuth } from "@/lib/cron/assert-cron-bearer-auth"
import {
  getAcquisitionOrchestratorConfig,
  isAcquisitionOrchestratorStubsAllowed,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import { acquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import {
  createDefaultStubStepRunners,
  createUnwiredStepRunners,
  runAcquisitionOrchestrator,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.service"
import { createProductionStepRunners } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-workers"
import type { AcquisitionOrchestratorRunResult } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"

export interface AcquisitionOrchestratorRouteDeps {
  run?: (input: { runId: string }) => Promise<AcquisitionOrchestratorRunResult>
  createRunId?: () => string
}

async function defaultRun(runId: string): Promise<AcquisitionOrchestratorRunResult> {
  const steps = isAcquisitionOrchestratorStubsAllowed()
    ? createDefaultStubStepRunners()
    : createProductionStepRunners()

  return runAcquisitionOrchestrator({
    runId,
    leaseRepository: acquisitionOrchestratorLeaseRepository,
    steps,
    config: getAcquisitionOrchestratorConfig(),
  })
}

/**
 * Handler HTTP orchestrateur — auth Bearer puis runId avant gates/lease.
 */
export async function handleAcquisitionOrchestratorCron(
  req: Request,
  deps: AcquisitionOrchestratorRouteDeps = {}
): Promise<Response> {
  const unauthorized = assertCronBearerAuth(req)
  if (unauthorized) return unauthorized

  const createRunId = deps.createRunId ?? (() => crypto.randomUUID())
  const runId = createRunId()

  try {
    const result = await (deps.run ? deps.run({ runId }) : defaultRun(runId))
    return NextResponse.json(result)
  } catch {
    return NextResponse.json(
      {
        error: "Acquisition orchestrator cron failed",
        code: "ACQUISITION_ORCHESTRATOR_CRON_FAILED",
        runId,
      },
      { status: 500 }
    )
  }
}

/** Exposé pour tests Lot A (chemin sans workers). */
export function __testDefaultUnwiredRunners() {
  return createUnwiredStepRunners()
}
