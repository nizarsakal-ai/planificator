/**
 * PLAN-ACQ-005C-MVP — Types revue humaine (pas de Prisma / Client / Worksite).
 */

import type { Role, WorksiteImportDraftStatus } from "@prisma/client"

export type ReviewActorContext = {
  actorUserId: string
  actorRole: Role
  companyId: string
}

export type ImportDraftListItem = {
  draftId: string
  status: WorksiteImportDraftStatus
  version: number
  proposedWorksiteName: string | null
  lastExtractionErrorCode: string | null
  updatedAt: Date
  message: {
    subject: string
    senderEmail: string
    receivedAt: Date
  }
}

export type ImportDraftReviewAttachment = {
  id: string
  filename: string
  mimeType: string
  category: string
  sizeBytes: number
  status: string
}

export type ImportDraftReviewBundle = {
  draft: {
    id: string
    status: WorksiteImportDraftStatus
    version: number
    proposedWorksiteName: string | null
    proposedClientName: string | null
    proposedAddress: string | null
    proposedPostalCode: string | null
    proposedCity: string | null
    proposedStartDate: Date | null
    proposedEndDate: Date | null
    proposedDescription: string | null
    proposedContactName: string | null
    proposedContactEmail: string | null
    proposedContactPhone: string | null
    confidenceData: unknown
    warningData: unknown
    extractionProvider: string | null
    extractionModel: string | null
    lastExtractionErrorCode: string | null
    reviewedByUserId: string | null
    reviewedAt: Date | null
    rejectionReason: string | null
    createdWorksiteId: string | null
    updatedAt: Date
  }
  message: {
    id: string
    senderEmail: string
    subject: string
    receivedAt: Date
  }
  content: {
    normalizedText: string | null
  }
  attachments: ImportDraftReviewAttachment[]
}

export type ReviewProposedFields = {
  proposedWorksiteName: string | null
  proposedClientName: string | null
  proposedAddress: string | null
  proposedPostalCode: string | null
  proposedCity: string | null
  proposedStartDate: string | null
  proposedEndDate: string | null
  proposedDescription: string | null
}

/** DTO minimal RSC → client pour le formulaire de corrections. */
export type ConsultationProposedFormDto = {
  id: string
  status: WorksiteImportDraftStatus
  version: number
  proposedWorksiteName: string | null
  proposedClientName: string | null
  proposedAddress: string | null
  proposedPostalCode: string | null
  proposedCity: string | null
  /** YYYY-MM-DD ou null */
  proposedStartDate: string | null
  /** YYYY-MM-DD ou null */
  proposedEndDate: string | null
  proposedDescription: string | null
  proposedContactName: string | null
  proposedContactEmail: string | null
  proposedContactPhone: string | null
  extractionEnabled: boolean
}

export type ImportDraftStatusSnapshot = {
  id: string
  status: WorksiteImportDraftStatus
  version: number
}

export type SaveCorrectionsOutcome =
  | { ok: true; outcome: "SAVED"; draftId: string; version: number; status: WorksiteImportDraftStatus }
  | {
      ok: false
      outcome:
        | "STATE_CHANGED"
        | "INVALID_STATE"
        | "VALIDATION_ERROR"
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "DISABLED"
      code: string
      message: string
    }

export type ApproveOutcome =
  | { ok: true; outcome: "APPROVED"; draftId: string; version: number }
  | {
      ok: false
      outcome:
        | "VALIDATION_ERROR"
        | "BLOCKING_WARNINGS"
        | "STATE_CHANGED"
        | "INVALID_STATE"
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "DISABLED"
      code: string
      message: string
    }

export type RejectOutcome =
  | { ok: true; outcome: "REJECTED"; draftId: string; version: number }
  | {
      ok: false
      outcome:
        | "VALIDATION_ERROR"
        | "STATE_CHANGED"
        | "INVALID_STATE"
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "DISABLED"
      code: string
      message: string
    }

export type ReExtractOutcome =
  | { ok: true; outcome: string; draftId: string; status?: string }
  | { ok: false; outcome: string; code: string; message: string }
