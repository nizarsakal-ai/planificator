/** Feature flag + bornes du cron orchestrateur download PJ (PLAN-ACQ-004C). */

export const DEFAULT_ATTACHMENT_MAX_PER_COMPANY = 20
export const DEFAULT_ATTACHMENT_MAX_PER_RUN = 100
export const DEFAULT_ATTACHMENT_MAX_COMPANIES_PER_RUN = 20
export const DEFAULT_ATTACHMENT_CRON_MAX_DURATION_MS = 240_000

const MIN_POSITIVE = 1
const MAX_PER_COMPANY_CAP = 200
const MAX_PER_RUN_CAP = 1_000
const MAX_COMPANIES_CAP = 200
const MAX_DURATION_MS_CAP = 900_000

/** Cron download inactif par défaut. */
export function isAttachmentDownloadCronEnabled(): boolean {
  return process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED === "true"
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

export interface AttachmentDownloadCronConfig {
  maxPerCompany: number
  maxPerRun: number
  maxCompaniesPerRun: number
  maxDurationMs: number
}

export function getAttachmentDownloadCronConfig(): AttachmentDownloadCronConfig {
  return {
    maxPerCompany: parseBoundedInt(
      process.env.ACQUISITION_ATTACHMENT_MAX_PER_COMPANY,
      DEFAULT_ATTACHMENT_MAX_PER_COMPANY,
      MIN_POSITIVE,
      MAX_PER_COMPANY_CAP
    ),
    maxPerRun: parseBoundedInt(
      process.env.ACQUISITION_ATTACHMENT_MAX_PER_RUN,
      DEFAULT_ATTACHMENT_MAX_PER_RUN,
      MIN_POSITIVE,
      MAX_PER_RUN_CAP
    ),
    maxCompaniesPerRun: parseBoundedInt(
      process.env.ACQUISITION_ATTACHMENT_MAX_COMPANIES_PER_RUN,
      DEFAULT_ATTACHMENT_MAX_COMPANIES_PER_RUN,
      MIN_POSITIVE,
      MAX_COMPANIES_CAP
    ),
    maxDurationMs: parseBoundedInt(
      process.env.ACQUISITION_ATTACHMENT_CRON_MAX_DURATION_MS,
      DEFAULT_ATTACHMENT_CRON_MAX_DURATION_MS,
      MIN_POSITIVE,
      MAX_DURATION_MS_CAP
    ),
  }
}
