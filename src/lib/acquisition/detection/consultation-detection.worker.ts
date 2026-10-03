/**
 * PLAN-ACQ-DETECTION-001 — Worker batch Detection (restartable, fairness).
 * Barrière pré-extraction. Ownership orchestrateur pour chemin AUTO.
 * PLAN-ACQ-DETECTION-001-R1 — fence TX obligatoire si ensureOwnership présent.
 */

import {
  DefaultConsultationDetectionCapability,
  type ConsultationDetectionRuntimeResult,
} from "@/lib/acquisition/capabilities/consultation-detection.capability"
import {
  AcquisitionConsultationDetectionSelectionRepository,
  acquisitionConsultationDetectionSelectionRepository,
  type ConsultationDetectionCandidate,
  type ConsultationDetectionSelectionRepository,
} from "@/lib/acquisition/detection/consultation-detection.selection.repository"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"
import {
  isOrchestratorOwnershipValid,
  type OrchestratorItemOwnershipCheck,
} from "@/lib/acquisition/orchestrator/orchestrator-ownership"

const LOG_PREFIX = "[acquisition-consultation-detection]"

export const DETECTION_WORKER_MAX_CANDIDATES = 25
export const DETECTION_WORKER_MAX_COMPANIES = 20
export const DETECTION_WORKER_MAX_PER_COMPANY = 5

export type ConsultationDetectionWorkerStats = {
  selected: number
  detected: number
  staleContent: number
  stateChanged: number
  leaseStolen: number
  errors: number
  skippedNoContent: number
}

export type ConsultationDetectionWorkerRunResult = {
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED"
  skipReason?: string
  error?: { code: string; message: string }
  errorCode?: string
  stats: ConsultationDetectionWorkerStats
  durationMs: number
  runId: string
}

export type ConsultationDetectionWorkerDeps = {
  selection?: ConsultationDetectionSelectionRepository
  detect?: (input: {
    companyId: string
    acquisitionMessageId: string
  }) => Promise<ConsultationDetectionRuntimeResult>
  ensureOwnership?: OrchestratorItemOwnershipCheck
  /** LOT-3G / R1 — obligatoire si ensureOwnership (chemin AUTO). */
  transactionalOwnershipFence?: TransactionalOwnershipFence
  now?: () => Date
  maxCandidates?: number
  maxCompanies?: number
  maxPerCompany?: number
  maxDurationMs?: number
  log?: (event: string, payload?: Record<string, unknown>) => void
}

function defaultLog(event: string, payload?: Record<string, unknown>): void {
  if (payload) console.log(`${LOG_PREFIX} ${event}`, payload)
  else console.log(`${LOG_PREFIX} ${event}`)
}

function emptyStats(): ConsultationDetectionWorkerStats {
  return {
    selected: 0,
    detected: 0,
    staleContent: 0,
    stateChanged: 0,
    leaseStolen: 0,
    errors: 0,
    skippedNoContent: 0,
  }
}

function leaseStolenResult(input: {
  started: number
  runId: string
  stats: ConsultationDetectionWorkerStats
  message: string
}): ConsultationDetectionWorkerRunResult {
  return {
    status: "FAILED",
    skipReason: "LEASE_STOLEN",
    errorCode: "LEASE_STOLEN",
    error: { code: "LEASE_STOLEN", message: input.message },
    stats: input.stats,
    durationMs: Date.now() - input.started,
    runId: input.runId,
  }
}

async function selectFairCandidates(input: {
  selection: ConsultationDetectionSelectionRepository
  maxCompanies: number
  maxPerCompany: number
  maxCandidates: number
}): Promise<ConsultationDetectionCandidate[]> {
  const companyIds = await input.selection.listCompanyIdsNeedingDetection({
    limit: input.maxCompanies,
  })
  const buckets: ConsultationDetectionCandidate[][] = []
  for (const companyId of companyIds) {
    const rows = await input.selection.listCandidatesForCompany({
      companyId,
      limit: input.maxPerCompany,
    })
    buckets.push(rows)
  }
  const merged: ConsultationDetectionCandidate[] = []
  let idx = 0
  while (merged.length < input.maxCandidates) {
    let progressed = false
    for (const bucket of buckets) {
      if (idx < bucket.length) {
        merged.push(bucket[idx]!)
        progressed = true
        if (merged.length >= input.maxCandidates) break
      }
    }
    if (!progressed) break
    idx += 1
  }
  return merged
}

export async function runConsultationDetectionWorker(
  deps: ConsultationDetectionWorkerDeps = {}
): Promise<ConsultationDetectionWorkerRunResult> {
  const started = Date.now()
  const runId = `detection-${started}`
  const log = deps.log ?? defaultLog
  const stats = emptyStats()
  const maxDurationMs = deps.maxDurationMs ?? 55_000
  const deadline = started + maxDurationMs
  const ensureOwnership = deps.ensureOwnership
  const fence = deps.transactionalOwnershipFence

  // R1 — chemin AUTO : ensureOwnership sans fence = fail-closed.
  if (ensureOwnership && !fence) {
    stats.leaseStolen += 1
    return leaseStolenResult({
      started,
      runId,
      stats,
      message: "Fence transactionnel absent",
    })
  }

  const selection =
    deps.selection ?? acquisitionConsultationDetectionSelectionRepository

  const detect =
    deps.detect ??
    ((input: { companyId: string; acquisitionMessageId: string }) =>
      new DefaultConsultationDetectionCapability({
        transactionalOwnershipFence: fence,
        now: deps.now,
      }).detectConsultation({
        companyId: input.companyId,
        acquisitionMessageId: input.acquisitionMessageId,
        subject: null,
        senderEmail: null,
        senderDomain: null,
      }))

  if (!(await isOrchestratorOwnershipValid(ensureOwnership))) {
    stats.leaseStolen += 1
    return leaseStolenResult({
      started,
      runId,
      stats,
      message: "Lease perdu avant Detection",
    })
  }

  let candidates: ConsultationDetectionCandidate[]
  try {
    candidates = await selectFairCandidates({
      selection,
      maxCompanies: deps.maxCompanies ?? DETECTION_WORKER_MAX_COMPANIES,
      maxPerCompany: deps.maxPerCompany ?? DETECTION_WORKER_MAX_PER_COMPANY,
      maxCandidates: deps.maxCandidates ?? DETECTION_WORKER_MAX_CANDIDATES,
    })
  } catch (err) {
    log("DETECTION_SELECTION_FAILED", {
      message: err instanceof Error ? err.message : "unknown",
    })
    return {
      status: "FAILED",
      error: {
        code: "DETECTION_SELECTION_FAILED",
        message: "Sélection Detection échouée",
      },
      stats,
      durationMs: Date.now() - started,
      runId,
    }
  }

  stats.selected = candidates.length
  if (candidates.length === 0) {
    return {
      status: "SUCCESS",
      stats,
      durationMs: Date.now() - started,
      runId,
    }
  }

  for (const candidate of candidates) {
    if (Date.now() >= deadline) break
    if (!(await isOrchestratorOwnershipValid(ensureOwnership))) {
      stats.leaseStolen += 1
      return leaseStolenResult({
        started,
        runId,
        stats,
        message: "Lease perdu pendant Detection",
      })
    }

    try {
      const result = await detect({
        companyId: candidate.companyId,
        acquisitionMessageId: candidate.acquisitionMessageId,
      })
      switch (result.persistOutcome) {
        case "PERSISTED":
          stats.detected += 1
          break
        case "STALE_CONTENT":
          stats.staleContent += 1
          break
        case "STATE_CHANGED":
          stats.stateChanged += 1
          break
        case "LEASE_NOT_OWNED":
          stats.leaseStolen += 1
          return leaseStolenResult({
            started,
            runId,
            stats,
            message: "Lease perdu avant persist Detection (fence TX)",
          })
        case "NO_CONTENT":
        case "NO_DRAFT":
          stats.skippedNoContent += 1
          break
        default:
          stats.errors += 1
      }
    } catch (err) {
      stats.errors += 1
      log("DETECTION_ITEM_FAILED", {
        draftId: candidate.draftId,
        message: err instanceof Error ? err.message : "unknown",
      })
    }
  }

  const status =
    stats.errors > 0 || stats.leaseStolen > 0
      ? stats.detected > 0
        ? "PARTIAL"
        : "FAILED"
      : "SUCCESS"

  return {
    status,
    stats,
    durationMs: Date.now() - started,
    runId,
  }
}

/** Réexport type pour tests. */
export type { ConsultationDetectionSelectionRepository }
export { AcquisitionConsultationDetectionSelectionRepository }
