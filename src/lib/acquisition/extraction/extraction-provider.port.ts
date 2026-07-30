/**
 * PLAN-ACQ-005B — Port provider extraction.
 * Port pur : aucune dépendance Prisma / Anthropic / métier / secrets.
 */

export type ExtractionEvidenceSource =
  | "BODY"
  | "SUBJECT"
  | "ATTACHMENT_META"
  | "ATTACHMENT_TEXT"
  | "HEURISTIC"

export type NormalizedExtractAttachmentMeta = {
  filename: string
  mimeType: string
  category: string
  sizeBytes: number
}

/** Extraits texte PJ (PDF progressif Lot E) — jamais binaire. */
export type AttachmentTextExcerpt = {
  filename: string
  mimeType: string
  text: string
}

export type NormalizedExtractInput = {
  subject: string | null
  normalizedText: string
  locale: "fr-FR"
  attachmentMetadata: NormalizedExtractAttachmentMeta[]
  /** Extraits texte PJ optionnels (multimodal progressif). */
  attachmentTextExcerpts?: AttachmentTextExcerpt[]
  extractionSchemaVersion: "1" | "2"
}

export type ExtractionProviderFieldValue = {
  value: unknown
  confidence: number
  evidence?: {
    source: ExtractionEvidenceSource
    quote?: string
  }
}

export type ExtractionProviderWarning = {
  code: string
  message?: string
  field?: string
}

export type ExtractionProviderResult = {
  fields: Record<string, ExtractionProviderFieldValue>
  warnings: ExtractionProviderWarning[]
  providerMetadata: {
    providerId: string
    model?: string
    latencyMs?: number
  }
}

export interface ExtractionProviderPort {
  extract(input: NormalizedExtractInput): Promise<ExtractionProviderResult>
}
