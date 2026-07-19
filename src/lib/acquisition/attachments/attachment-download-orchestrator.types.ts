import type { AttachmentDownloadOutcome } from "@/lib/acquisition/attachments/attachment.types"
import type { AttachmentDownloadCronConfig } from "@/lib/acquisition/attachments/attachment-download-cron-feature-flag"

/** Erreur publique cron download — jamais de détail interne. */
export interface PublicAttachmentDownloadCronError {
  code: string
  message: string
  retryable: boolean
}

const PUBLIC_ERROR_CATALOG: Record<string, { message: string; retryable: boolean }> = {
  ATTACHMENT_DOWNLOAD_CRON_DISABLED: {
    message: "Attachment download cron is disabled",
    retryable: false,
  },
  ATTACHMENT_CANDIDATE_LISTING_FAILED: {
    message: "Unable to list attachment download candidates",
    retryable: true,
  },
  COMPANY_ATTACHMENT_DOWNLOAD_FAILED: {
    message: "Attachment download failed for this company",
    retryable: true,
  },
  COMPANY_ATTACHMENT_DOWNLOAD_PARTIAL: {
    message: "Attachment download partially completed for this company",
    retryable: true,
  },
}

export function toPublicAttachmentDownloadCronError(
  code: keyof typeof PUBLIC_ERROR_CATALOG | string
): PublicAttachmentDownloadCronError {
  const entry = PUBLIC_ERROR_CATALOG[code]
  if (entry) {
    return { code, message: entry.message, retryable: entry.retryable }
  }
  return {
    code: "COMPANY_ATTACHMENT_DOWNLOAD_FAILED",
    message: PUBLIC_ERROR_CATALOG.COMPANY_ATTACHMENT_DOWNLOAD_FAILED.message,
    retryable: true,
  }
}

export function safeAttachmentDownloadCronInternalErrorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name
  return "UNKNOWN_ERROR"
}

export type AttachmentDownloadCronRunStatus = "SKIPPED" | "SUCCESS" | "PARTIAL" | "FAILED"

export type AttachmentDownloadCronBudgetReason =
  | "MAX_ATTACHMENTS_PER_RUN"
  | "MAX_COMPANIES_PER_RUN"
  | "MAX_DURATION_MS"

export interface AttachmentDownloadCronOutcomeStats {
  attempted: number
  stored: number
  alreadyStored: number
  alreadyInProgress: number
  rejected: number
  failed: number
  skipped: number
}

export type AttachmentDownloadCronCompanyStatus =
  | "SUCCESS"
  | "PARTIAL"
  | "FAILED"
  | "SKIPPED"

export interface AttachmentDownloadCronCompanyResult {
  companyId: string
  status: AttachmentDownloadCronCompanyStatus
  durationMs: number
  stats: AttachmentDownloadCronOutcomeStats
  error?: PublicAttachmentDownloadCronError
  skipReason?: "NO_CANDIDATES" | "BUDGET_REACHED"
  partialReason?: AttachmentDownloadCronBudgetReason | "HAS_FAILURES"
}

export interface AttachmentDownloadCronRunResult {
  status: AttachmentDownloadCronRunStatus
  runId: string
  skipReason?: "CRON_DISABLED"
  error?: PublicAttachmentDownloadCronError
  errorCode?: string
  budgetReached?: AttachmentDownloadCronBudgetReason
  startedAt: string
  finishedAt: string
  durationMs: number
  companiesTotal: number
  companiesSucceeded: number
  companiesPartial: number
  companiesFailed: number
  companiesSkipped: number
  globalStats: AttachmentDownloadCronOutcomeStats
  companies: AttachmentDownloadCronCompanyResult[]
  config: AttachmentDownloadCronConfig
}

export interface DiscoveredAttachmentCandidate {
  id: string
  companyId: string
  createdAt: Date
}

export interface AttachmentDownloadOrchestratorRepository {
  listCompanyIdsWithDiscoveredAttachments(input: {
    limit: number
  }): Promise<string[]>
  listDiscoveredAttachmentsForCompany(input: {
    companyId: string
    limit: number
  }): Promise<DiscoveredAttachmentCandidate[]>
}

export interface AttachmentDownloadOrchestratorDownloadPort {
  (input: {
    companyId: string
    attachmentId: string
  }): Promise<{ outcome: AttachmentDownloadOutcome }>
}

export function emptyOutcomeStats(): AttachmentDownloadCronOutcomeStats {
  return {
    attempted: 0,
    stored: 0,
    alreadyStored: 0,
    alreadyInProgress: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
  }
}

export function mergeOutcomeStats(
  target: AttachmentDownloadCronOutcomeStats,
  source: AttachmentDownloadCronOutcomeStats
): void {
  target.attempted += source.attempted
  target.stored += source.stored
  target.alreadyStored += source.alreadyStored
  target.alreadyInProgress += source.alreadyInProgress
  target.rejected += source.rejected
  target.failed += source.failed
  target.skipped += source.skipped
}

export function recordOutcome(
  stats: AttachmentDownloadCronOutcomeStats,
  outcome: AttachmentDownloadOutcome
): void {
  stats.attempted += 1
  switch (outcome) {
    case "STORED":
      stats.stored += 1
      break
    case "ALREADY_STORED":
      stats.alreadyStored += 1
      break
    case "ALREADY_IN_PROGRESS":
      stats.alreadyInProgress += 1
      break
    case "REJECTED":
      stats.rejected += 1
      break
    case "FAILED":
      stats.failed += 1
      break
    case "SKIPPED":
      stats.skipped += 1
      break
  }
}
