import type { CanonicalMailAttachment } from "@/lib/acquisition/connector/connector.types"
import type { GmailMessagePart, GmailMessagePayload } from "@/lib/acquisition/connector/gmail-api.types"

const DEFAULT_MAX_DEPTH = 20

function isAttachmentPart(part: GmailMessagePart): boolean {
  const filename = part.filename?.trim()
  const attachmentId = part.body?.attachmentId?.trim()
  return Boolean(filename || attachmentId)
}

/**
 * Parcourt récursivement la structure MIME Gmail et extrait les métadonnées
 * des pièces jointes (sans décoder le binaire).
 */
export function extractAttachmentMetadataFromPayload(
  payload: GmailMessagePayload | GmailMessagePart | undefined,
  maxDepth = DEFAULT_MAX_DEPTH
): CanonicalMailAttachment[] {
  if (!payload) return []

  const results: CanonicalMailAttachment[] = []
  const seen = new Set<string>()

  function walk(part: GmailMessagePart, depth: number, ordinal: number): void {
    if (depth > maxDepth) return

    if (isAttachmentPart(part)) {
      const partId = part.partId ?? `ord:${ordinal}`
      const externalId = part.body?.attachmentId?.trim()
      const filename = part.filename?.trim() || (externalId ? `attachment-${externalId}` : `part-${partId}`)
      const dedupeKey = externalId ? `ext:${externalId}` : `part:${partId}:${filename}`
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey)
        results.push({
          externalAttachmentId: externalId,
          partId: part.partId,
          filename,
          mimeType: part.mimeType ?? "application/octet-stream",
          sizeBytes: part.body?.size ?? 0,
        })
      }
    }

    for (let i = 0; i < (part.parts?.length ?? 0); i++) {
      walk(part.parts![i], depth + 1, i)
    }
  }

  walk(payload as GmailMessagePart, 0, 0)
  return results
}

export function getGmailHeader(
  headers: { name: string; value: string }[] | undefined,
  name: string
): string {
  if (!headers?.length) return ""
  const target = name.toLowerCase()
  return headers.find((h) => h.name.toLowerCase() === target)?.value ?? ""
}

export function parseReceivedAt(
  internalDate: string | undefined,
  dateHeader: string | undefined
): Date {
  if (internalDate) {
    const ms = Number(internalDate)
    if (!Number.isNaN(ms)) return new Date(ms)
  }
  if (dateHeader) {
    const parsed = new Date(dateHeader)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}
