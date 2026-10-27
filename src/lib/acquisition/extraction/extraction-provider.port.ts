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
  | "ATTACHMENT_VISUAL"

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

/**
 * PLAN-ACQ-MULTIMODAL — Pièce visuelle (photo, PDF sans couche texte) transmise
 * telle quelle à un provider capable de vision. Données NON FIABLES.
 * Type déterminé par signature magique, jamais par le MIME déclaré seul.
 */
export type AttachmentVisualInput =
  | {
      filename: string
      kind: "image"
      mediaType: "image/jpeg" | "image/png"
      base64: string
      byteLength: number
    }
  | {
      filename: string
      kind: "pdf"
      mediaType: "application/pdf"
      base64: string
      byteLength: number
    }

export type NormalizedExtractInput = {
  subject: string | null
  normalizedText: string
  locale: "fr-FR"
  attachmentMetadata: NormalizedExtractAttachmentMeta[]
  /** Extraits texte PJ optionnels (multimodal progressif). */
  attachmentTextExcerpts?: AttachmentTextExcerpt[]
  /**
   * PLAN-ACQ-MULTIMODAL — Pièces visuelles (bornées en amont). Fournies
   * uniquement si le provider déclare `supportsVisualInputs` ET flag ON.
   */
  attachmentVisuals?: AttachmentVisualInput[]
  extractionSchemaVersion: "1" | "2" | "3"
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
  /**
   * PLAN-ACQ-MULTIMODAL — true si le provider sait lire `attachmentVisuals`
   * (blocs natifs image/document). Absent = false (deterministic).
   */
  readonly supportsVisualInputs?: boolean
}
