/** Erreur publique cron Acquisition — jamais de message brut interne. */
export interface PublicCronError {
  code: string
  message: string
  retryable: boolean
}

const PUBLIC_ERROR_CATALOG: Record<string, { message: string; retryable: boolean }> = {
  GMAIL_CONNECTION_LISTING_FAILED: {
    message: "Unable to list Gmail connections",
    retryable: true,
  },
  COMPANY_SYNC_FAILED: {
    message: "Gmail synchronization failed for this company",
    retryable: true,
  },
  COMPANY_SYNC_PARTIAL: {
    message: "Gmail synchronization partially completed for this company",
    retryable: true,
  },
  CRON_DISABLED: {
    message: "Acquisition Gmail cron is disabled",
    retryable: false,
  },
}

export function toPublicCronError(code: keyof typeof PUBLIC_ERROR_CATALOG | string): PublicCronError {
  const entry = PUBLIC_ERROR_CATALOG[code]
  if (entry) {
    return { code, message: entry.message, retryable: entry.retryable }
  }
  return {
    code: "COMPANY_SYNC_FAILED",
    message: PUBLIC_ERROR_CATALOG.COMPANY_SYNC_FAILED.message,
    retryable: true,
  }
}

export function mapCompanySyncStatusToPublicError(
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "SKIPPED"
): PublicCronError | undefined {
  if (status === "PARTIAL") return toPublicCronError("COMPANY_SYNC_PARTIAL")
  if (status === "FAILED") return toPublicCronError("COMPANY_SYNC_FAILED")
  return undefined
}

/** Code technique pour logs internes — sans message brut ni secret. */
export function safeInternalErrorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name
  return "UNKNOWN_ERROR"
}
