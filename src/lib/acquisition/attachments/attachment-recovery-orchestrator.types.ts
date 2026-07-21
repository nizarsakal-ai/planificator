export type AttachmentRecoveryCronRunStatus = "SKIPPED" | "SUCCESS" | "PARTIAL" | "FAILED"

export type AttachmentRecoveryCronBudgetReason =
  | "MAX_PER_RUN"
  | "MAX_COMPANIES_PER_RUN"
  | "MAX_DURATION_MS"

export type AttachmentRecoveryPhaseStats = {
  companiesProcessed: number
  companiesSucceeded: number
  companiesPartial: number
  companiesFailed: number
  companiesSkipped: number
  attempted: number
  transitioned: number
  noop: number
}

export type AttachmentRecoveryCronCompanyStatus = "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED"

export type AttachmentRecoveryCronCompanyResult = {
  companyId: string
  phase: "RECLAIM" | "RETRY"
  status: AttachmentRecoveryCronCompanyStatus
  attempted: number
  transitioned: number
  noop: number
  errorCode?: string
}

export type AttachmentRecoveryCronRunResult = {
  status: AttachmentRecoveryCronRunStatus
  runId: string
  skipReason?: "CRON_DISABLED" | "MASTER_DISABLED" | "DOWNLOAD_CAPABILITY_DISABLED"
  startedAt: string
  finishedAt: string
  durationMs: number
  budgetReason?: AttachmentRecoveryCronBudgetReason
  reclaim: AttachmentRecoveryPhaseStats
  retry: AttachmentRecoveryPhaseStats
  companies: AttachmentRecoveryCronCompanyResult[]
  config: {
    reclaimTtlMs: number
    maxRetries: number
    maxPerCompany: number
    maxPerRun: number
    maxCompaniesPerRun: number
    maxDurationMs: number
  }
}

export const PUBLIC_RECOVERY_ERROR_CATALOG = {
  ATTACHMENT_RECOVERY_CRON_DISABLED: {
    code: "ATTACHMENT_RECOVERY_CRON_DISABLED",
    message: "Cron recovery pièces jointes désactivé",
  },
  ATTACHMENT_RECOVERY_LISTING_FAILED: {
    code: "ATTACHMENT_RECOVERY_LISTING_FAILED",
    message: "Échec du listing des candidats recovery",
  },
  COMPANY_ATTACHMENT_RECOVERY_FAILED: {
    code: "COMPANY_ATTACHMENT_RECOVERY_FAILED",
    message: "Échec recovery pour une entreprise",
  },
} as const

export function toPublicAttachmentRecoveryCronError(
  code: keyof typeof PUBLIC_RECOVERY_ERROR_CATALOG
): { code: string; message: string } {
  return PUBLIC_RECOVERY_ERROR_CATALOG[code]
}

export function safeAttachmentRecoveryCronInternalErrorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name
  return "UNKNOWN"
}

export function emptyPhaseStats(): AttachmentRecoveryPhaseStats {
  return {
    companiesProcessed: 0,
    companiesSucceeded: 0,
    companiesPartial: 0,
    companiesFailed: 0,
    companiesSkipped: 0,
    attempted: 0,
    transitioned: 0,
    noop: 0,
  }
}

export interface AttachmentRecoveryOrchestratorRepository {
  listCompanyIdsWithReclaimCandidates(input: {
    olderThan: Date
    limit: number
  }): Promise<string[]>
  listPendingDownloadsForReclaim(input: {
    companyId: string
    olderThan: Date
    limit: number
  }): Promise<Array<{ id: string; companyId: string; downloadClaimedAt: Date }>>
  reclaimPendingDownload(input: {
    companyId: string
    attachmentId: string
    olderThan: Date
  }): Promise<"RECLAIMED" | "NOOP">
  listCompanyIdsWithRetryCandidates(input: {
    now: Date
    maxRetries: number
    limit: number
  }): Promise<string[]>
  listFailedAttachmentsForRetry(input: {
    companyId: string
    now: Date
    limit: number
    maxRetries: number
    retryableErrorCodes: string[]
  }): Promise<
    Array<{
      id: string
      companyId: string
      downloadRetryCount: number
      lastErrorCode: string | null
    }>
  >
  scheduleRetryToDiscovered(input: {
    companyId: string
    attachmentId: string
    now: Date
    maxRetries: number
    retryableErrorCodes: string[]
  }): Promise<"TRANSITIONED" | "NOOP">
}
