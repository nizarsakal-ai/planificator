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
 * Headers de SOUS-PARTS conservés pour la seule classification MIME du parser
 * (ressource inline embarquée vs pièce jointe). Structure temporaire : jamais persistée,
 * jamais exposée (le modèle canonique ne transporte pas le payload).
 */
const ALLOWED_SUBPART_HEADER_NAMES = new Set(["content-disposition", "content-id"])

function extractAllowedSubpartHeaders(
  headers: { name: string; value: string }[] | undefined
): { name: string; value: string }[] {
  if (!headers?.length) return []
  return headers.filter(
    (h) => typeof h?.name === "string" && ALLOWED_SUBPART_HEADER_NAMES.has(h.name.toLowerCase())
  )
}

/**
 * Retire body.data de la structure MIME avant extraction des métadonnées PJ.
 * Ne conserve que partId, mimeType, filename, body.attachmentId, body.size et,
 * sur les sous-parts, uniquement Content-Disposition / Content-ID (classification inline).
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
    const headers = extractAllowedSubpartHeaders(part.headers)
    if (headers.length) {
      sanitized.headers = headers
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
