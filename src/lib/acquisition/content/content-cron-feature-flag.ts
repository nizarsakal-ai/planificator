/** PLAN-ACQ-OPS-003 — Flag + bornes du cron fetch content. */

export const DEFAULT_CONTENT_MAX_PER_COMPANY = 20
export const DEFAULT_CONTENT_MAX_PER_RUN = 100
export const DEFAULT_CONTENT_MAX_COMPANIES_PER_RUN = 20
export const DEFAULT_CONTENT_CRON_MAX_DURATION_MS = 240_000
export const DEFAULT_CONTENT_CRON_MAX_ATTEMPTS = 5

const MIN_POSITIVE = 1
const MAX_PER_COMPANY_CAP = 200
const MAX_PER_RUN_CAP = 1_000
const MAX_COMPANIES_CAP = 200
const MAX_DURATION_MS_CAP = 900_000
const MAX_ATTEMPTS_CAP = 20

/** Cron content fetch inactif par défaut. */
export function isAcquisitionContentCronEnabled(): boolean {
  return process.env.ACQUISITION_CONTENT_CRON_ENABLED === "true"
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

export interface ContentCronConfig {
  maxPerCompany: number
  maxPerRun: number
  maxCompaniesPerRun: number
  maxDurationMs: number
  maxAttempts: number
}

export function getContentCronConfig(): ContentCronConfig {
  return {
    maxPerCompany: parseBoundedInt(
      process.env.ACQUISITION_CONTENT_MAX_PER_COMPANY,
      DEFAULT_CONTENT_MAX_PER_COMPANY,
      MIN_POSITIVE,
      MAX_PER_COMPANY_CAP
    ),
    maxPerRun: parseBoundedInt(
      process.env.ACQUISITION_CONTENT_MAX_PER_RUN,
      DEFAULT_CONTENT_MAX_PER_RUN,
      MIN_POSITIVE,
      MAX_PER_RUN_CAP
    ),
    maxCompaniesPerRun: parseBoundedInt(
      process.env.ACQUISITION_CONTENT_MAX_COMPANIES_PER_RUN,
      DEFAULT_CONTENT_MAX_COMPANIES_PER_RUN,
      MIN_POSITIVE,
      MAX_COMPANIES_CAP
    ),
    maxDurationMs: parseBoundedInt(
      process.env.ACQUISITION_CONTENT_CRON_MAX_DURATION_MS,
      DEFAULT_CONTENT_CRON_MAX_DURATION_MS,
      MIN_POSITIVE,
      MAX_DURATION_MS_CAP
    ),
    maxAttempts: parseBoundedInt(
      process.env.ACQUISITION_CONTENT_CRON_MAX_ATTEMPTS,
      DEFAULT_CONTENT_CRON_MAX_ATTEMPTS,
      MIN_POSITIVE,
      MAX_ATTEMPTS_CAP
    ),
  }
}

/** Backoff minutes : min(15, 2^attemptCount) après un échec retryable. */
export function contentFetchBackoffMinutes(attemptCount: number): number {
  const safe = Math.max(1, Math.floor(attemptCount))
  return Math.min(15, 2 ** safe)
}
