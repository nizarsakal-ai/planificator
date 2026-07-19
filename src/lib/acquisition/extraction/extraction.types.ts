/**
 * PLAN-ACQ-005B — Types métier extraction (hors Prisma / Anthropic).
 */

import type { Role } from "@prisma/client"
import type { z } from "zod"
import type {
  extractionCanonicalFieldsSchema,
  extractionConfidenceMapSchema,
  extractionWarningSchema,
} from "@/lib/acquisition/extraction/extraction.schema"

export type ExtractionActor = {
  userId: string
  role: Role
  companyId: string | null
}

export type ExtractionOutcome =
  | "EXTRACTED"
  | "ALREADY_EXTRACTED"
  | "IN_PROGRESS"
  | "STATE_CHANGED"
  | "RETRY_ALLOWED"
  | "CONTENT_MISSING"
  | "STALE_CONTENT"
  | "DISABLED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "FAILED"
  | "MAX_ATTEMPTS_REACHED"

export type ExtractionErrorCode =
  | "EXTRACTION_DISABLED"
  | "ACQUISITION_DISABLED"
  | "CONTENT_FETCH_DISABLED"
  | "CONTENT_MISSING"
  | "STALE_CONTENT"
  | "DRAFT_NOT_FOUND"
  | "EXTRACTION_FORBIDDEN"
  | "EXTRACTION_IN_PROGRESS"
  | "EXTRACTION_STATE_CHANGED"
  | "EXTRACTION_ALREADY_DONE"
  | "EXTRACTION_MAX_ATTEMPTS"
  | "EXTRACTION_INVALID_STATUS"
  | "EMPTY_EXTRACTION"
  | "CONTENT_INSUFFICIENT"
  | "DATE_RANGE_INVALID"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_INVALID_OUTPUT"
  | "PROVIDER_DISABLED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_INTERNAL_ERROR"
  | "PROVIDER_INPUT_TOO_LARGE"
  | "ZOD_VALIDATION_FAILED"
  | "INTERNAL_ERROR"

export type ExtractionWarningSeverity = "INFO" | "WARNING" | "ERROR"

export type ExtractionWarningCode =
  | "CONTENT_INSUFFICIENT"
  | "EMPTY_EXTRACTION"
  | "DATE_RANGE_INVALID"
  | "DATE_AMBIGUOUS"
  | "MISSING_REQUIRED_FOR_CONVERSION"
  | "LOW_CONFIDENCE"
  | "INVALID_EMAIL"
  | "INVALID_PHONE"
  | "CLIENT_IDENTITY_AMBIGUOUS"
  | "PROVIDER_PARTIAL_RESULT"
  | "UNSUPPORTED_ATTACHMENT_TYPE"
  | "POTENTIAL_PROMPT_INJECTION"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "STALE_CONTENT"
  | "INPUT_TRUNCATED_FOR_PROVIDER"

export type ExtractionWarning = z.infer<typeof extractionWarningSchema>
export type ExtractionCanonicalFields = z.infer<typeof extractionCanonicalFieldsSchema>
export type ExtractionConfidenceMap = z.infer<typeof extractionConfidenceMapSchema>

export type ExtractionSuccessResult = {
  ok: true
  outcome: "EXTRACTED" | "ALREADY_EXTRACTED"
  draftId: string
  status: "PENDING_REVIEW"
  contentHashAtExtraction: string
  warningCount: number
}

export type ExtractionFailureResult = {
  ok: false
  outcome: Exclude<ExtractionOutcome, "EXTRACTED" | "ALREADY_EXTRACTED">
  code: ExtractionErrorCode
  message: string
  draftId?: string
  status?: string
  attemptCount?: number
  maxAttempts?: number
}

export type ExtractDraftResult = ExtractionSuccessResult | ExtractionFailureResult

export type RunDraftExtractionInput = {
  actor: ExtractionActor
  draftId: string
  force?: boolean
  now?: () => Date
}
