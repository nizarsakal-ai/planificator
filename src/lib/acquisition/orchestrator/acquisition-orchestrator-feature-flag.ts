/**
 * PLAN-ACQ-V2-001 — Flag cron orchestrateur Acquisition.
 * Inactif par défaut (`=== "true"` uniquement).
 */

const DEFAULT_MAX_DURATION_MS = 240_000
const DEFAULT_SAFETY_MARGIN_MS = 5_000
const DEFAULT_LEASE_TTL_MS = 360_000
const MIN_POSITIVE = 1
const MAX_DURATION_MS_CAP = 900_000
const MAX_LEASE_TTL_MS_CAP = 3_600_000

export const ACQUISITION_ORCHESTRATOR_LEASE_KEY = "acquisition-orchestrator" as const

export function isAcquisitionOrchestratorCronEnabled(): boolean {
  return process.env.ACQUISITION_ORCHESTRATOR_CRON_ENABLED === "true"
}

/** Autorise explicitement les stubs SUCCESS (tests / debug uniquement). */
export function isAcquisitionOrchestratorStubsAllowed(): boolean {
  return process.env.ACQUISITION_ORCHESTRATOR_ALLOW_STUBS === "true"
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw == null || raw.trim() === "") return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return Math.min(parsed, max)
}

export interface AcquisitionOrchestratorConfig {
  maxDurationMs: number
  safetyMarginMs: number
  leaseTtlMs: number
}

/**
 * Invariant R1 : leaseTtlMs >= maxDurationMs + safetyMarginMs
 * (évite vol de lease pendant qu’un run est encore vivant).
 */
export function getAcquisitionOrchestratorConfig(): AcquisitionOrchestratorConfig {
  const maxDurationMs = parseBoundedInt(
    process.env.ACQUISITION_ORCHESTRATOR_MAX_DURATION_MS,
    DEFAULT_MAX_DURATION_MS,
    MIN_POSITIVE,
    MAX_DURATION_MS_CAP
  )
  const safetyMarginMs = parseBoundedInt(
    process.env.ACQUISITION_ORCHESTRATOR_SAFETY_MARGIN_MS,
    DEFAULT_SAFETY_MARGIN_MS,
    MIN_POSITIVE,
    60_000
  )
  const minLease = maxDurationMs + safetyMarginMs
  const rawLease = parseBoundedInt(
    process.env.ACQUISITION_ORCHESTRATOR_LEASE_TTL_MS,
    Math.max(DEFAULT_LEASE_TTL_MS, minLease),
    MIN_POSITIVE,
    MAX_LEASE_TTL_MS_CAP
  )
  return {
    maxDurationMs,
    safetyMarginMs,
    leaseTtlMs: Math.max(rawLease, minLease),
  }
}
