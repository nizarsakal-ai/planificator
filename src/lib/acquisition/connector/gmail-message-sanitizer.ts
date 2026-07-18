import type { GmailMessagePart, GmailMessagePayload, GmailMessageResource } from "@/lib/acquisition/connector/gmail-api.types"

/** Headers autorisés dans le modèle canonique — whitelist stricte. */
const ALLOWED_HEADER_NAMES = new Set(["from", "subject", "date", "message-id"])

/**
 * Extrait uniquement les headers autorisés — aucun corps, token ou header sensible.
 */
export function extractAllowedHeaders(
  headers: { name: string; value: string }[] | undefined
): { name: string; value: string }[] {
  if (!headers?.length) return []
  return headers.filter((h) => ALLOWED_HEADER_NAMES.has(h.name.toLowerCase()))
}

/**
 * Retire body.data de la structure MIME avant extraction des métadonnées PJ.
 * Ne conserve que partId, mimeType, filename, body.attachmentId et body.size.
 */
export function sanitizePayloadForMetadata(
  payload: GmailMessagePayload | undefined
): GmailMessagePayload | undefined {
  if (!payload) return undefined

  function sanitizePart(part: GmailMessagePart): GmailMessagePart {
    const sanitized: GmailMessagePart = {
      partId: part.partId,
      mimeType: part.mimeType,
      filename: part.filename,
    }
    if (part.body) {
      sanitized.body = {
        attachmentId: part.body.attachmentId,
        size: part.body.size,
      }
    }
    if (part.parts?.length) {
      sanitized.parts = part.parts.map(sanitizePart)
    }
    return sanitized
  }

  return {
    partId: payload.partId,
    mimeType: payload.mimeType,
    filename: payload.filename,
    headers: extractAllowedHeaders(payload.headers),
    parts: payload.parts?.map(sanitizePart),
  }
}

/** Métadonnées provider autorisées dans le modèle canonique. */
export function buildAllowedProviderMetadata(resource: GmailMessageResource): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  if (resource.historyId) metadata.historyId = resource.historyId

  const messageIdHeader = extractAllowedHeaders(resource.payload?.headers).find(
    (h) => h.name.toLowerCase() === "message-id"
  )
  if (messageIdHeader?.value) metadata.messageIdHeader = messageIdHeader.value

  return metadata
}
