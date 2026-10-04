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

/** Codes déterministes (GMAIL_*, CURSOR_*, Prisma P2002…) — jamais de texte libre. */
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * Code technique pour logs internes — sans message brut ni secret.
 * Priorité : `error.code` s'il respecte le format code → `error.name` → UNKNOWN_ERROR.
 */
export function safeInternalErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && SAFE_CODE_RE.test(code)) return code
  }
  if (error instanceof Error && error.name && SAFE_NAME_RE.test(error.name)) return error.name
  return "UNKNOWN_ERROR"
}

/** Filtre un code déjà produit en interne avant journalisation. */
export function sanitizeInternalCode(code: unknown): string | undefined {
  return typeof code === "string" && (SAFE_CODE_RE.test(code) || SAFE_NAME_RE.test(code))
    ? code
    : undefined
}
