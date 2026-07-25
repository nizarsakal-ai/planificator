import type { CanonicalMailAttachment } from "@/lib/acquisition/connector/connector.types"
import type { GmailMessagePart, GmailMessagePayload } from "@/lib/acquisition/connector/gmail-api.types"

const DEFAULT_MAX_DEPTH = 20
const MAX_FILENAME_LEN = 255

/** Extensions fiables uniquement — pas de guess hasardeux. */
const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/zip": "zip",
  "application/json": "json",
}

/**
 * Pièce jointe téléchargeable uniquement si Gmail fournit un attachmentId non vide.
 * Les parties inline (filename seul, Content-ID, body.data sans attachmentId) sont ignorées.
 */
export function isDownloadableGmailAttachmentPart(part: GmailMessagePart): boolean {
  return Boolean(part.body?.attachmentId?.trim())
}

/** Nettoie un filename Gmail : basename, sans contrôles, longueur bornée. */
export function sanitizeAttachmentFilename(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? ""
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "_")
    .trim()
  if (!cleaned) return ""
  return cleaned.slice(0, MAX_FILENAME_LEN)
}

function safePartLabel(partId: string | undefined, ordinal: number): string {
  const trimmed = partId?.trim()
  if (trimmed) {
    // Identifiant MIME stable — caractères sûrs seulement pour le nom généré.
    const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
    return safe || `ord-${ordinal}`
  }
  return `ord-${ordinal}`
}

function extensionForMime(mimeType: string): string | null {
  return MIME_TO_EXT[mimeType.trim().toLowerCase()] ?? null
}

/**
 * Nom déterministe si filename Gmail absent/vide après sanitize.
 * Forme : attachment-<partId|ord-n>[.ext]
 */
export function buildDeterministicAttachmentFilename(input: {
  partId?: string
  ordinal: number
  mimeType: string
}): string {
  const label = safePartLabel(input.partId, input.ordinal)
  const ext = extensionForMime(input.mimeType)
  const base = `attachment-${label}`
  const withExt = ext ? `${base}.${ext}` : base
  return withExt.slice(0, MAX_FILENAME_LEN)
}

/**
 * Parcourt récursivement la structure MIME Gmail et extrait les métadonnées
 * des pièces jointes téléchargeables (sans décoder le binaire).
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

    if (isDownloadableGmailAttachmentPart(part)) {
      const externalId = part.body!.attachmentId!.trim()
      const mimeType = (part.mimeType?.trim() || "application/octet-stream").slice(0, 127)
      const partIdRaw = part.partId?.trim()
      const sanitizedName = sanitizeAttachmentFilename(part.filename ?? "")
      const filename =
        sanitizedName ||
        buildDeterministicAttachmentFilename({
          partId: partIdRaw,
          ordinal,
          mimeType,
        })

      const dedupeKey = `ext:${externalId}`
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey)
        results.push({
          externalAttachmentId: externalId,
          ...(partIdRaw ? { partId: partIdRaw.slice(0, 64) } : {}),
          filename,
          mimeType,
          sizeBytes: Math.max(0, Math.floor(part.body?.size ?? 0)),
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
