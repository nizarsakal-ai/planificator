/**
 * PLAN-ACQ-V2 Lot E / R3 — Multimodal progressif (PDF texte d’abord).
 * Parse couche texte via unpdf (pas d’OCR).
 * PLAN-ACQ-MULTIMODAL : la lecture complète (xlsx, vision photos / PDF scannés)
 * est dans attachment-reading.ts (readAttachmentsForExtraction) ; ce module ne
 * conserve que les plafonds partagés et `appendAttachmentTextToBody`.
 */

import type { AttachmentTextExcerpt } from "@/lib/acquisition/extraction/extraction-provider.port"

export const MAX_EXCERPT_CHARS = 8_000
export const MAX_TOTAL_CHARS = 24_000
export const PDF_PARSE_TIMEOUT_MS = 3_000

/** Enrichit le corps email avec les extraits texte des PJ (PDF, xlsx). */
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
