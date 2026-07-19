/** Sortie canonique du port source — aucun token, MIME brut ni body.data. */
export interface CanonicalMessageBodyParts {
  textPlain: string | null
  textHtml: string | null
  mimeType: string | null
  charset: string | null
  providerMessageId: string
  /** Taille approximative des buffers texte décodés (méta sûre). */
  byteLengthOriginal: number
}

export interface FetchMessageContentSourceInput {
  companyId: string
  externalMessageId: string
}

export interface AcquisitionMessageContentSourcePort {
  fetchMessageBody(input: FetchMessageContentSourceInput): Promise<CanonicalMessageBodyParts>
}

export interface SanitizedMessageContent {
  normalizedText: string
  contentHash: string
  sourceMimeType: string | null
  sourceCharset: string | null
  hadHtml: boolean
  byteLengthOriginal: number
  /** Octets UTF-8 du texte normalisé final. */
  byteLengthNormalized: number
  sanitizedAt: Date
}

export interface MessageContentRecord {
  id: string
  companyId: string
  acquisitionMessageId: string
  normalizedText: string
  contentHash: string
  sourceMimeType: string | null
  sourceCharset: string | null
  hadHtml: boolean
  byteLengthOriginal: number
  fetchedAt: Date
  sanitizedAt: Date
  createdAt: Date
  updatedAt: Date
}

export type MessageContentOutcome =
  | "FETCHED"
  | "ALREADY_FETCHED"
  | "UPDATED"
  | "EMPTY_CONTENT"
  | "DISABLED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNAUTHORIZED"
  | "ACQUISITION_CONTENT_TOO_LARGE"
  | "FAILED"

export type MessageContentErrorCode =
  | "CONTENT_FETCH_DISABLED"
  | "CONTENT_UNAUTHORIZED"
  | "CONTENT_FORBIDDEN"
  | "CONTENT_NOT_FOUND"
  | "CONTENT_EMPTY"
  | "ACQUISITION_CONTENT_TOO_LARGE"
  | "CONTENT_PERSIST_FAILED"
  | "GMAIL_NOT_CONNECTED"
  | "GMAIL_TOKEN_REFRESH_FAILED"
  | "GMAIL_UNAUTHORIZED"
  | "GMAIL_RATE_LIMITED"
  | "GMAIL_UNAVAILABLE"
  | "GMAIL_MESSAGE_NOT_FOUND"
  | "GMAIL_MESSAGE_PARSE_ERROR"
  | "CONTENT_FETCH_FAILED"

export type FetchMessageContentResult =
  | {
      ok: true
      outcome: "FETCHED" | "ALREADY_FETCHED" | "UPDATED"
      content: MessageContentRecord
      idempotent: boolean
    }
  | {
      ok: false
      outcome: Exclude<MessageContentOutcome, "FETCHED" | "ALREADY_FETCHED" | "UPDATED">
      code: MessageContentErrorCode
      message: string
    }

export interface UpsertMessageContentResult {
  record: MessageContentRecord
  outcome: "FETCHED" | "ALREADY_FETCHED" | "UPDATED"
}
