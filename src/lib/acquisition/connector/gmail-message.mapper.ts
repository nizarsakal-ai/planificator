import type { CanonicalMailMessage } from "@/lib/acquisition/connector/connector.types"
import type { RegisterIncomingMessageInput } from "@/lib/validations/acquisition"

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
    attachments: message.attachments.map((a) => ({
      externalAttachmentId: a.externalAttachmentId,
      partId: a.partId,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    })),
  }
}
