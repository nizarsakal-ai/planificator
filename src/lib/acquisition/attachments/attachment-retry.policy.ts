import type { AttachmentDownloadErrorCode } from "@/lib/acquisition/attachments/attachment.types"

/**
 * Allowlist exclusive des codes FAILED retryables (PLAN-ACQ-004D / L2).
 * GMAIL_UNAUTHORIZED / GMAIL_PROVIDER_FAILED exclus — pas de boucle sur auth/erreurs terminales ;
 * reprise après reconnexion = prérequis ops (mécanisme applicatif futur, pas SQL).
 */
export const RETRYABLE_ATTACHMENT_ERROR_CODES = [
  "GMAIL_NOT_CONNECTED",
  "ATTACHMENT_STORAGE_FAILED",
  "GMAIL_RATE_LIMITED",
  "GMAIL_UNAVAILABLE",
] as const satisfies readonly AttachmentDownloadErrorCode[]

export type RetryableAttachmentErrorCode = (typeof RETRYABLE_ATTACHMENT_ERROR_CODES)[number]

const RETRYABLE_SET: ReadonlySet<string> = new Set(RETRYABLE_ATTACHMENT_ERROR_CODES)

/** Membership allowlist uniquement — code absent/inconnu → non retryable. */
export function isRetryableAttachmentErrorCode(code: string | null | undefined): boolean {
  if (!code) return false
  return RETRYABLE_SET.has(code)
}
