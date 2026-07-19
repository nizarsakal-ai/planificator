/**
 * PLAN-ACQ-005B — Port provider extraction.
 * Port pur : aucune dépendance Prisma / Anthropic / métier / secrets.
 */

export type ExtractionEvidenceSource =
  | "BODY"
  | "SUBJECT"
  | "ATTACHMENT_META"
  | "HEURISTIC"

export type NormalizedExtractAttachmentMeta = {
  filename: string
  mimeType: string
  category: string
  sizeBytes: number
}

export type NormalizedExtractInput = {
  subject: string | null
  normalizedText: string
  locale: "fr-FR"
  attachmentMetadata: NormalizedExtractAttachmentMeta[]
  extractionSchemaVersion: "1"
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
