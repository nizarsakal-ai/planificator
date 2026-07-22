/** PLAN-ACQ-OPS-004 — Flag + bornes du cron extraction. */

import {
  getExtractionMaxAttempts,
  getExtractionReclaimTtlMs,
  getExtractionTimeoutMs,
} from "@/lib/acquisition/extraction/extraction-feature-flag"

export const DEFAULT_EXTRACTION_MAX_PER_COMPANY = 10
export const DEFAULT_EXTRACTION_MAX_PER_RUN = 50
export const DEFAULT_EXTRACTION_MAX_COMPANIES_PER_RUN = 20
export const DEFAULT_EXTRACTION_CRON_MAX_DURATION_MS = 240_000
export const DEFAULT_EXTRACTION_CRON_SAFETY_MARGIN_MS = 5_000

const MIN_POSITIVE = 1
const MAX_PER_COMPANY_CAP = 200
const MAX_PER_RUN_CAP = 1_000
const MAX_COMPANIES_CAP = 200
const MAX_DURATION_MS_CAP = 900_000

/** Cron extraction inactif par défaut. */
export function isAcquisitionExtractionCronEnabled(): boolean {
  return process.env.ACQUISITION_EXTRACTION_CRON_ENABLED === "true"
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

export interface ExtractionCronConfig {
  maxPerCompany: number
  maxPerRun: number
  maxCompaniesPerRun: number
  maxDurationMs: number
  safetyMarginMs: number
  /** Même source que 005B — non dupliqué arbitrairement. */
  providerTimeoutMs: number
  maxAttempts: number
  reclaimTtlMs: number
}

export function getExtractionCronConfig(): ExtractionCronConfig {
  return {
    maxPerCompany: parseBoundedInt(
      process.env.ACQUISITION_EXTRACTION_MAX_PER_COMPANY,
      DEFAULT_EXTRACTION_MAX_PER_COMPANY,
      MIN_POSITIVE,
      MAX_PER_COMPANY_CAP
    ),
    maxPerRun: parseBoundedInt(
      process.env.ACQUISITION_EXTRACTION_MAX_PER_RUN,
      DEFAULT_EXTRACTION_MAX_PER_RUN,
      MIN_POSITIVE,
      MAX_PER_RUN_CAP
    ),
    maxCompaniesPerRun: parseBoundedInt(
      process.env.ACQUISITION_EXTRACTION_MAX_COMPANIES_PER_RUN,
      DEFAULT_EXTRACTION_MAX_COMPANIES_PER_RUN,
      MIN_POSITIVE,
      MAX_COMPANIES_CAP
    ),
    maxDurationMs: parseBoundedInt(
      process.env.ACQUISITION_EXTRACTION_CRON_MAX_DURATION_MS,
      DEFAULT_EXTRACTION_CRON_MAX_DURATION_MS,
      MIN_POSITIVE,
      MAX_DURATION_MS_CAP
    ),
    safetyMarginMs: parseBoundedInt(
      process.env.ACQUISITION_EXTRACTION_CRON_SAFETY_MARGIN_MS,
      DEFAULT_EXTRACTION_CRON_SAFETY_MARGIN_MS,
      MIN_POSITIVE,
      60_000
    ),
    providerTimeoutMs: getExtractionTimeoutMs(),
    maxAttempts: getExtractionMaxAttempts(),
    reclaimTtlMs: getExtractionReclaimTtlMs(),
  }
}

/**
 * Backoff sélection OPS-004 (SPEC-R1) :
 * attemptCount <= 0 → 0 ; sinon min(15, 2^(attemptCount - 1)).
 */
export function extractionCronBackoffMinutes(attemptCount: number): number {
  const n = Math.floor(attemptCount)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(15, 2 ** (n - 1))
}

/**
 * Helper backoff FAILED / PENDING uniquement.
 * `EXTRACTING` stale est géré exclusivement par la requête SQL de sélection (reclaim TTL 005B) —
 * ne pas traiter tout EXTRACTING comme dû ici.
 */
export function isExtractionRetryDue(input: {
  status: string
  lastExtractionErrorAt: Date | null
  extractionAttemptCount: number
  now: Date
}): boolean {
  if (input.status === "PENDING_EXTRACTION") return true
  if (input.status === "EXTRACTING") return false
  if (input.status !== "FAILED") return false
  if (input.lastExtractionErrorAt == null) return false
  const delayMs = extractionCronBackoffMinutes(input.extractionAttemptCount) * 60_000
  return input.now.getTime() >= input.lastExtractionErrorAt.getTime() + delayMs
}
