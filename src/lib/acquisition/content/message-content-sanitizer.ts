import { createHash } from "node:crypto"
import type { CanonicalMessageBodyParts, SanitizedMessageContent } from "@/lib/acquisition/content/message-content.types"

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\b(api[_-]?key|password|secret|token)\s*[:=]\s*\S+/gi,
  /\bAIza[0-9A-Za-z\-_]{20,}/g,
]

/**
 * Convertit un fragment HTML en texte approximatif sans dépendance externe.
 * Retire scripts, styles, iframes, commentaires et balises.
 */
export function htmlToPlainText(html: string): string {
  let s = html
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, " ")
  s = s.replace(/<!--[\s\S]*?-->/g, " ")
  s = s.replace(/<br\s*\/?>/gi, "\n")
  s = s.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
  s = s.replace(/<[^>]+>/g, " ")
  s = s.replace(/&nbsp;/gi, " ")
  s = s.replace(/&amp;/gi, "&")
  s = s.replace(/&lt;/gi, "<")
  s = s.replace(/&gt;/gi, ">")
  s = s.replace(/&quot;/gi, '"')
  s = s.replace(/&#39;/gi, "'")
  s = s.replace(/&#(\d+);/g, (_, n) => {
    const code = Number(n)
    return Number.isFinite(code) && code > 0 && code < 65536 ? String.fromCharCode(code) : " "
  })
  return s
}

function stripTrackingAndNoise(text: string): string {
  let s = text
  s = s.replace(/\bdata:[^\s]+/gi, " ")
  s = s.replace(/https?:\/\/\S*(utm_|track|click|open)\S*/gi, " ")
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, "[REDACTED]")
  }
  s = s.replace(/\n--\s*\n[\s\S]*$/m, "\n")
  s = s.replace(/\nEnvoyé depuis mon .*$/gim, "")
  s = s.replace(/\nSent from my .*$/gim, "")
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  s = s.replace(/[ \t]+\n/g, "\n")
  s = s.replace(/\n{3,}/g, "\n\n")
  s = s.replace(/[ \t]{2,}/g, " ")
  return s.trim()
}

export function hashNormalizedText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/**
 * Préfère text/plain ; fallback HTML→texte.
 * Aucune troncature — le service refuse si byteLength UTF-8 dépasse le plafond.
 */
export function sanitizeMessageBodyParts(parts: CanonicalMessageBodyParts): SanitizedMessageContent {
  const hadHtml = Boolean(parts.textHtml?.trim())
  let raw: string
  let sourceMimeType: string | null

  if (parts.textPlain?.trim()) {
    raw = parts.textPlain
    sourceMimeType = "text/plain"
  } else if (parts.textHtml?.trim()) {
    raw = htmlToPlainText(parts.textHtml)
    sourceMimeType = "text/html"
  } else {
    raw = ""
    sourceMimeType = parts.mimeType
  }

  const normalizedText = stripTrackingAndNoise(raw)
  const byteLengthNormalized = Buffer.byteLength(normalizedText, "utf8")

  return {
    normalizedText,
    contentHash: hashNormalizedText(normalizedText),
    sourceMimeType,
    sourceCharset: parts.charset,
    hadHtml,
    byteLengthOriginal: parts.byteLengthOriginal,
    byteLengthNormalized,
    sanitizedAt: new Date(),
  }
}
