/**
 * PLAN-ACQ-V2-001 — Contrat JSON orchestrateur Acquisition.
 */

export const ORCHESTRATOR_STEP_KEYS = [
  "gmailSync",
  "attachmentRecovery",
  "attachmentDownload",
  "contentFetch",
  "extraction",
] as const

export type OrchestratorStepKey = (typeof ORCHESTRATOR_STEP_KEYS)[number]

export type AcquisitionOrchestratorRunStatus =
  | "SUCCESS"
  | "PARTIAL"
  | "FAILED"
  | "SKIPPED"

export type AcquisitionOrchestratorSkipReason =
  | "CRON_DISABLED"
  | "MASTER_DISABLED"
  | "ALREADY_RUNNING"

export type OrchestratorStepStatus =
  | "SUCCESS"
  | "PARTIAL"
  | "FAILED"
  | "SKIPPED"
  | "NOT_RUN"

export type OrchestratorStepSkipReason =
  | "BUDGET_EXHAUSTED"
  | "LEASE_STOLEN"
  | "WORKERS_NOT_WIRED"
  | string

export interface OrchestratorPublicError {
  code: string
  message: string
}

export interface OrchestratorStepResult {
  status: OrchestratorStepStatus
  durationMs: number
  skipReason?: OrchestratorStepSkipReason
  error?: OrchestratorPublicError
  result?: unknown
}

export type OrchestratorStepsMap = Record<OrchestratorStepKey, OrchestratorStepResult>

export interface AcquisitionOrchestratorRunResult {
  status: AcquisitionOrchestratorRunStatus
  skipReason?: AcquisitionOrchestratorSkipReason
  runId: string
  startedAt: string
  finishedAt: string
  durationMs: number
  steps: OrchestratorStepsMap
  /** Présent si la libération de lease a échoué après exécution. */
  leaseReleaseFailed?: boolean
}

/** Résultat renvoyé par un runner d’étape injectable. */
export interface OrchestratorStepRunnerResult {
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED"
  result?: unknown
  error?: OrchestratorPublicError
  skipReason?: string
}

export type OrchestratorStepRunner = (ctx: {
  runId: string
  remainingMs: number
}) => Promise<OrchestratorStepRunnerResult>

export interface AcquisitionOrchestratorStepRunners {
  gmailSync: OrchestratorStepRunner
  attachmentRecovery: OrchestratorStepRunner
  attachmentDownload: OrchestratorStepRunner
  contentFetch: OrchestratorStepRunner
  extraction: OrchestratorStepRunner
}

export type LeaseAcquireOutcome =
  | { outcome: "ACQUIRED" }
  | { outcome: "ALREADY_RUNNING" }

export type LeaseReleaseOutcome =
  | { outcome: "RELEASED" }
  | { outcome: "NOT_OWNER" }
  | { outcome: "NOT_FOUND" }

export type LeaseOwnershipOutcome =
  | { outcome: "OWNED" }
  | { outcome: "NOT_OWNER" }
  | { outcome: "NOT_FOUND" }

export interface AcquisitionOrchestratorLeaseRepositoryPort {
  acquire(input: {
    key: string
    ownerRunId: string
    leaseTtlMs: number
  }): Promise<LeaseAcquireOutcome>
  release(input: {
    key: string
    ownerRunId: string
  }): Promise<LeaseReleaseOutcome>
  /** Fence anti-zombie : vérifie que ce run possède encore la lease. */
  assertOwned(input: {
    key: string
    ownerRunId: string
  }): Promise<LeaseOwnershipOutcome>
  /** Heartbeat : prolonge leaseExpiresAt si toujours propriétaire. */
  renew?(input: {
    key: string
    ownerRunId: string
    leaseTtlMs: number
  }): Promise<LeaseOwnershipOutcome>
}
