import type { CanonicalMailMessage } from "@/lib/acquisition/connector/connector.types"
import type { RegisterIncomingMessageInput } from "@/lib/validations/acquisition"
import {
  buildDeterministicAttachmentFilename,
  sanitizeAttachmentFilename,
} from "@/lib/acquisition/connector/gmail-mime-parser"

const FORBIDDEN_METADATA_KEYS = [
  "accesstoken",
  "refreshtoken",
  "authorization",
  "password",
  "cookie",
  "secret",
] as const

function sanitizeProviderMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase()
    if (FORBIDDEN_METADATA_KEYS.some((f) => lower.includes(f))) continue
    out[key] = value
  }
  return out
}

/**
 * Normalise les métadonnées PJ pour le schéma Zod Acquisition.
 * Ignore toute entrée sans attachmentId Gmail exploitable (défense en profondeur).
 */
function mapCanonicalAttachments(
  attachments: CanonicalMailMessage["attachments"]
): RegisterIncomingMessageInput["attachments"] {
  const out: NonNullable<RegisterIncomingMessageInput["attachments"]> = []
  let ordinal = 0
  for (const a of attachments) {
    const externalAttachmentId = a.externalAttachmentId?.trim()
    if (!externalAttachmentId) continue

    const mimeType = (a.mimeType?.trim() || "application/octet-stream").slice(0, 127)
    const partId = a.partId?.trim() || undefined
    const sanitized = sanitizeAttachmentFilename(a.filename ?? "")
    const filename =
      sanitized ||
      buildDeterministicAttachmentFilename({
        partId,
        ordinal,
        mimeType,
      })

    out.push({
      externalAttachmentId: externalAttachmentId.slice(0, 255),
      ...(partId ? { partId: partId.slice(0, 64) } : {}),
      filename: filename.slice(0, 255),
      mimeType,
      sizeBytes: Math.max(0, Math.floor(a.sizeBytes ?? 0)),
    })
    ordinal++
  }
  return out
}

/**
 * Transforme un message Gmail normalisé en entrée du service d'acquisition.
 * Aucune règle LAURALU — l'éligibilité est déléguée à acquisition.service.ts.
 */
export function mapGmailMessageToAcquisitionInput(
  message: CanonicalMailMessage,
  companyId: string
): RegisterIncomingMessageInput {
  const rawMetadata: Record<string, unknown> = {
    threadId: message.threadId,
    labels: message.labels,
    ...(message.snippet ? { snippet: message.snippet.slice(0, 500) } : {}),
    ...sanitizeProviderMetadata(message.providerMetadata),
  }

  return {
    companyId,
    source: "GMAIL",
    externalMessageId: message.externalMessageId,
    senderEmail: message.fromHeader,
    subject: message.subject,
    receivedAt: message.receivedAt,
    rawMetadata,
    attachments: mapCanonicalAttachments(message.attachments),
  }
}
