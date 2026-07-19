import type { AttachmentDownloadErrorCode } from "@/lib/acquisition/attachments/attachment.types"

/**
 * Allowlist exclusive des codes FAILED retryables (PLAN-ACQ-004D).
 * Deny by default — aucun retry sur error.message.
 */
export const RETRYABLE_ATTACHMENT_ERROR_CODES = [
  "GMAIL_NOT_CONNECTED",
  "ATTACHMENT_STORAGE_FAILED",
] as const satisfies readonly AttachmentDownloadErrorCode[]

export type RetryableAttachmentErrorCode = (typeof RETRYABLE_ATTACHMENT_ERROR_CODES)[number]

const RETRYABLE_SET: ReadonlySet<string> = new Set(RETRYABLE_ATTACHMENT_ERROR_CODES)

/** Membership allowlist uniquement — code absent/inconnu → non retryable. */
export function isRetryableAttachmentErrorCode(code: string | null | undefined): boolean {
  if (!code) return false
  return RETRYABLE_SET.has(code)
}
