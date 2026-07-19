import type { GmailMessagePart, GmailMessagePayload } from "@/lib/acquisition/connector/gmail-api.types"

const DEFAULT_MAX_DEPTH = 20

function decodeBase64Url(data: string): Buffer {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/")
  const padLength = (4 - (normalized.length % 4)) % 4
  const padded = normalized + "=".repeat(padLength)
  return Buffer.from(padded, "base64")
}

function isAttachmentPart(part: GmailMessagePart): boolean {
  const filename = part.filename?.trim()
  const attachmentId = part.body?.attachmentId?.trim()
  return Boolean(filename || attachmentId)
}

function charsetFromContentType(headers: { name: string; value: string }[] | undefined): string | null {
  if (!headers?.length) return null
  const ct = headers.find((h) => h.name.toLowerCase() === "content-type")?.value
  if (!ct) return null
  const match = ct.match(/charset\s*=\s*"?([^\s";]+)"?/i)
  return match?.[1]?.trim().toLowerCase() || null
}

function decodePartBody(part: GmailMessagePart): { text: string; bytes: number } | null {
  const data = part.body?.data
  if (!data) return null
  try {
    const buf = decodeBase64Url(data)
    return { text: buf.toString("utf8"), bytes: buf.length }
  } catch {
    return null
  }
}

export interface ExtractedBodyTexts {
  textPlain: string | null
  textHtml: string | null
  mimeType: string | null
  charset: string | null
  byteLengthOriginal: number
}

/**
 * Extrait text/plain et text/html depuis un payload Gmail full.
 * Ignore les parties attachment. Ne conserve aucun body.data dans le retour.
 */
export function extractTextPartsFromPayload(
  payload: GmailMessagePayload | undefined,
  maxDepth = DEFAULT_MAX_DEPTH
): ExtractedBodyTexts {
  let textPlain: string | null = null
  let textHtml: string | null = null
  let charset: string | null = null
  let byteLengthOriginal = 0
  const rootMime = payload?.mimeType ?? null

  function walk(part: GmailMessagePart, depth: number): void {
    if (depth > maxDepth) return
    if (isAttachmentPart(part)) {
      for (const child of part.parts ?? []) walk(child, depth + 1)
      return
    }

    const mime = (part.mimeType ?? "").toLowerCase()
    const decoded = decodePartBody(part)
    if (decoded) {
      byteLengthOriginal += decoded.bytes
      const partCharset = charsetFromContentType(part.headers)
      if (mime === "text/plain" && textPlain === null) {
        textPlain = decoded.text
        charset = partCharset ?? charset
      } else if (mime === "text/html" && textHtml === null) {
        textHtml = decoded.text
        charset = charset ?? partCharset
      }
    }

    for (const child of part.parts ?? []) walk(child, depth + 1)
  }

  if (payload) walk(payload as GmailMessagePart, 0)

  // Message simple (pas de multipart) : body sur la racine.
  if (!textPlain && !textHtml && payload?.body?.data && !isAttachmentPart(payload as GmailMessagePart)) {
    const decoded = decodePartBody(payload as GmailMessagePart)
    if (decoded) {
      byteLengthOriginal += decoded.bytes
      const mime = (payload.mimeType ?? "text/plain").toLowerCase()
      if (mime.includes("html")) textHtml = decoded.text
      else textPlain = decoded.text
      charset = charsetFromContentType(payload.headers)
    }
  }

  return {
    textPlain,
    textHtml,
    mimeType: textPlain ? "text/plain" : textHtml ? "text/html" : rootMime,
    charset,
    byteLengthOriginal,
  }
}
