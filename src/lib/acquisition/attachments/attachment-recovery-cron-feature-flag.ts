/** Feature flag + bornes du cron Recovery / Retry PJ (PLAN-ACQ-004D). */

export const DEFAULT_RECLAIM_TTL_MS = 20 * 60_000
export const DEFAULT_RETRY_MAX_RETRIES = 5
export const DEFAULT_RETRY_BASE_DELAY_MS = 60_000
export const DEFAULT_RETRY_MAX_DELAY_MS = 60 * 60_000
export const DEFAULT_RECOVERY_MAX_PER_COMPANY = 20
export const DEFAULT_RECOVERY_MAX_PER_RUN = 100
export const DEFAULT_RECOVERY_MAX_COMPANIES_PER_RUN = 20
export const DEFAULT_RECOVERY_MAX_DURATION_MS = 240_000

const MIN_POSITIVE = 1
const TTL_MS_MIN = 60_000
const TTL_MS_MAX = 24 * 60 * 60_000
const MAX_RETRIES_CAP = 20
const BASE_DELAY_CAP = 60 * 60_000
const MAX_DELAY_CAP = 24 * 60 * 60_000
const MAX_PER_COMPANY_CAP = 200
const MAX_PER_RUN_CAP = 1_000
const MAX_COMPANIES_CAP = 200
const MAX_DURATION_MS_CAP = 900_000

/** Cron recovery inactif par défaut. */
export function isAttachmentRecoveryCronEnabled(): boolean {
  return process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED === "true"
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

export interface AttachmentRecoveryCronConfig {
  reclaimTtlMs: number
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  maxPerCompany: number
  maxPerRun: number
  maxCompaniesPerRun: number
  maxDurationMs: number
}

export function getAttachmentRecoveryCronConfig(): AttachmentRecoveryCronConfig {
  const baseDelayMs = parseBoundedInt(
    process.env.ACQUISITION_ATTACHMENT_RETRY_BASE_DELAY_MS,
    DEFAULT_RETRY_BASE_DELAY_MS,
    MIN_POSITIVE,
    BASE_DELAY_CAP
  )
  const maxDelayMs = Math.max(
    baseDelayMs,
    parseBoundedInt(
      process.env.ACQUISITION_ATTACHMENT_RETRY_MAX_DELAY_MS,
      DEFAULT_RETRY_MAX_DELAY_MS,
      MIN_POSITIVE,
      MAX_DELAY_CAP
    )
  )

  return {
    reclaimTtlMs: parseBoundedInt(
      process.env.ACQUISITION_ATTACHMENT_RECLAIM_TTL_MS,
      DEFAULT_RECLAIM_TTL_MS,
      TTL_MS_MIN,
      TTL_MS_MAX
    ),
    maxRetries: parseBoundedInt(
      process.env.ACQUISITION_ATTACHMENT_RETRY_MAX_RETRIES,
      DEFAULT_RETRY_MAX_RETRIES,
      MIN_POSITIVE,
      MAX_RETRIES_CAP
    ),
    baseDelayMs,
    maxDelayMs,
    maxPerCompany: parseBoundedInt(
      process.env.ACQUISITION_ATTACHMENT_RECOVERY_MAX_PER_COMPANY,
      DEFAULT_RECOVERY_MAX_PER_COMPANY,
      MIN_POSITIVE,
      MAX_PER_COMPANY_CAP
    ),
    maxPerRun: parseBoundedInt(
      process.env.ACQUISITION_ATTACHMENT_RECOVERY_MAX_PER_RUN,
      DEFAULT_RECOVERY_MAX_PER_RUN,
      MIN_POSITIVE,
      MAX_PER_RUN_CAP
    ),
    maxCompaniesPerRun: parseBoundedInt(
      process.env.ACQUISITION_ATTACHMENT_RECOVERY_MAX_COMPANIES_PER_RUN,
      DEFAULT_RECOVERY_MAX_COMPANIES_PER_RUN,
      MIN_POSITIVE,
      MAX_COMPANIES_CAP
    ),
    maxDurationMs: parseBoundedInt(
      process.env.ACQUISITION_ATTACHMENT_RECOVERY_MAX_DURATION_MS,
      DEFAULT_RECOVERY_MAX_DURATION_MS,
      MIN_POSITIVE,
      MAX_DURATION_MS_CAP
    ),
  }
}
