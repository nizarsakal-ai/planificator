/**
 * PLAN-ACQ-ATTACHMENTS-002-L2 — Classification Gmail → codes download.
 * Contrat autorisé : GmailProviderError HEAD (code, retryable, message, global, messageId).
 * Aucune dépendance aux champs DIAG hors contrat HEAD.
 */

import type { AttachmentDownloadErrorCode } from "@/lib/acquisition/attachments/attachment.types"
import { isGmailProviderError } from "@/lib/acquisition/connector/gmail-api.client"

const NETWORK_HINT =
  /timeout|timed?\s*out|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network|AbortError/i

/**
 * Mappe une erreur Gmail/source vers un code AttachmentDownload contrôlé.
 * Ne journalise jamais token, attachmentId externe ni payload.
 */
export function mapGmailAttachmentFetchFailure(
  error: unknown
): AttachmentDownloadErrorCode {
  if (isGmailProviderError(error)) {
    switch (error.code) {
      case "GMAIL_UNAUTHORIZED":
        return "GMAIL_UNAUTHORIZED"
      case "GMAIL_TOKEN_REFRESH_FAILED":
        // Auth/refresh cassé — jamais NOT_FOUND, jamais retry auto auth.
        return "GMAIL_UNAUTHORIZED"
      case "GMAIL_RATE_LIMITED":
        return "GMAIL_RATE_LIMITED"
      case "GMAIL_UNAVAILABLE":
        return "GMAIL_UNAVAILABLE"
      case "GMAIL_NOT_CONNECTED":
        return "GMAIL_NOT_CONNECTED"
      case "GMAIL_MESSAGE_NOT_FOUND":
        // getAttachment utilise le contexte HTTP « message » → 404.
        return "GMAIL_ATTACHMENT_NOT_FOUND"
      case "GMAIL_MESSAGE_PARSE_ERROR":
        return "ATTACHMENT_DECODE_FAILED"
      case "LEGACY_MAILBOX_AMBIGUOUS":
        return "LEGACY_MAILBOX_AMBIGUOUS"
      default:
        // Codes Gmail hors mapping explicite (ex. HISTORY_EXPIRED, NO_ACTIVE_PARTNER…).
        // Retryable → temporaire ; sinon terminal générique (jamais faux NOT_FOUND).
        if (error.retryable) return "GMAIL_UNAVAILABLE"
        return "GMAIL_PROVIDER_FAILED"
    }
  }

  if (error instanceof Error) {
    if (error.name === "AbortError" || NETWORK_HINT.test(error.message)) {
      return "GMAIL_UNAVAILABLE"
    }
    const asCode = error.message as AttachmentDownloadErrorCode
    const passthrough: AttachmentDownloadErrorCode[] = [
      "GMAIL_ATTACHMENT_NOT_FOUND",
      "GMAIL_UNAUTHORIZED",
      "GMAIL_RATE_LIMITED",
      "GMAIL_UNAVAILABLE",
      "GMAIL_PROVIDER_FAILED",
      "GMAIL_NOT_CONNECTED",
      "LEGACY_MAILBOX_AMBIGUOUS",
      "ATTACHMENT_DECODE_FAILED",
    ]
    if (passthrough.includes(asCode)) return asCode
  }

  return "GMAIL_PROVIDER_FAILED"
}

/** Lève Error(message=code) pour le chemin downloadAcquisitionAttachment. */
export function throwMappedGmailAttachmentError(error: unknown): never {
  throw new Error(mapGmailAttachmentFetchFailure(error))
}
