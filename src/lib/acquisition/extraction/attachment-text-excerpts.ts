/**
 * PLAN-ACQ-V2 Lot E / R3 — Multimodal progressif (PDF texte d’abord).
 * Images/plans vision : hors sous-lot.
 * Parse couche texte via unpdf (pas d’OCR).
 */

import type { AttachmentTextExcerpt } from "@/lib/acquisition/extraction/extraction-provider.port"
import {
  extractPdfTextLayer,
  type PdfTextExtractStatus,
} from "@/lib/acquisition/extraction/pdf-text-extract"

const MAX_EXCERPT_CHARS = 8_000
const MAX_TOTAL_CHARS = 24_000
const PDF_PARSE_TIMEOUT_MS = 3_000

export type StoredAttachmentForText = {
  filename: string
  mimeType: string
  category: string
  /** Bytes PDF (STORED) — null si indisponible. */
  bytes?: Buffer | Uint8Array | null
  /** @deprecated préférer bytes — conservé pour tests unitaires excerpts. */
  extractedText?: string | null
}

export type AttachmentPdfOutcome = {
  filename: string
  status: PdfTextExtractStatus
}

export type BuildExcerptsResult = {
  excerpts: AttachmentTextExcerpt[]
  outcomes: AttachmentPdfOutcome[]
}

function isPdf(att: StoredAttachmentForText): boolean {
  const mime = (att.mimeType || "").toLowerCase()
  return mime === "application/pdf" || att.filename.toLowerCase().endsWith(".pdf")
}

/**
 * Construit des extraits texte pour le provider + outcomes PDF.
 * Jamais d’exception : PDF corrompu / sans texte → outcome, extraction message continue.
 */
export async function buildAttachmentTextExcerpts(
  attachments: StoredAttachmentForText[]
): Promise<BuildExcerptsResult> {
  const excerpts: AttachmentTextExcerpt[] = []
  const outcomes: AttachmentPdfOutcome[] = []
  let total = 0

  for (const att of attachments) {
    const mime = (att.mimeType || "").toLowerCase()
    if (mime.startsWith("image/")) continue
    if (!isPdf(att)) continue

    let status: PdfTextExtractStatus
    let text = ""

    if (att.bytes && att.bytes.byteLength > 0) {
      const result = await extractPdfTextLayer(att.bytes, {
        maxChars: MAX_EXCERPT_CHARS,
        timeoutMs: PDF_PARSE_TIMEOUT_MS,
      })
      status = result.status
      text = result.text
    } else if (att.extractedText != null && att.extractedText.trim()) {
      // Chemin test / pré-extrait
      text = att.extractedText.trim().slice(0, MAX_EXCERPT_CHARS)
      status =
        att.extractedText.trim().length > MAX_EXCERPT_CHARS
          ? "PDF_TEXT_TRUNCATED"
          : "PDF_TEXT_EXTRACTED"
    } else if (att.bytes != null && att.bytes.byteLength === 0) {
      status = "PDF_PARSE_FAILED"
    } else {
      // Pas de bytes → non lisible pour cette passe (pas d’OCR)
      status = "PDF_PARSE_FAILED"
    }

    outcomes.push({ filename: att.filename.slice(0, 255), status })

    if (
      (status === "PDF_TEXT_EXTRACTED" || status === "PDF_TEXT_TRUNCATED") &&
      text
    ) {
      if (total + text.length > MAX_TOTAL_CHARS) {
        const room = MAX_TOTAL_CHARS - total
        if (room <= 0) break
        text = text.slice(0, room)
        status = "PDF_TEXT_TRUNCATED"
        outcomes[outcomes.length - 1] = {
          filename: att.filename.slice(0, 255),
          status,
        }
      }
      excerpts.push({
        filename: att.filename.slice(0, 255),
        mimeType: att.mimeType.slice(0, 127),
        text,
      })
      total += text.length
    }
  }

  return { excerpts, outcomes }
}

/** Enrichit le corps email avec les extraits PDF. */
export function appendAttachmentTextToBody(
  body: string,
  excerpts: AttachmentTextExcerpt[]
): string {
  if (excerpts.length === 0) return body
  const blocks = excerpts.map(
    (e) => `\n\n--- PJ texte: ${e.filename} ---\n${e.text}`
  )
  return `${body}${blocks.join("")}`.slice(0, MAX_TOTAL_CHARS + body.length)
}
