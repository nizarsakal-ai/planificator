/**
 * PLAN-ACQ-MULTIMODAL — Repository extraction en mémoire (tests unitaires).
 * Même règle de fraîcheur que DraftExtractionRepository (MESSAGE_CONTENT / ATTACHMENTS_ONLY).
 */

import type { WorksiteImportDraftStatus } from "@prisma/client"
import type {
  AttachmentMetaRow,
  DraftExtractionRow,
  MessageContentLite,
  PersistExtractionInput,
} from "@/lib/acquisition/extraction/extraction.repository"
import {
  computeAttachmentsOnlyFingerprint,
  hasExploitableMessageText,
} from "@/lib/acquisition/extraction/extraction-source-fingerprint"

export type FakeDraft = DraftExtractionRow & {
  status: WorksiteImportDraftStatus
  proposedWorksiteName?: string | null
  proposedAddress?: string | null
  extractedData?: Record<string, unknown> | null
}

export function createFakeExtractionRepo(seed: {
  content?: MessageContentLite | null
  attachments?: AttachmentMetaRow[]
  draft?: Partial<FakeDraft>
  subject?: string | null
} = {}) {
  let draft: FakeDraft = {
    id: "d1",
    companyId: "co1",
    acquisitionMessageId: "m1",
    status: "PENDING_EXTRACTION",
    version: 0,
    extractionAttemptCount: 0,
    extractionStartedAt: null,
    contentHashAtExtraction: null,
    extractionSchemaVersion: null,
    detectionClassification: "CONSULTATION",
    detectionContentHash: "hash-text",
    extractionRetryable: null,
    ...seed.draft,
  }
  const state = {
    content: seed.content === undefined ? null : seed.content,
    attachments: seed.attachments ?? [],
  }
  const persists: PersistExtractionInput[] = []
  const markFails: Array<{
    errorCode: string
    extractionRetryable?: boolean
    warnings?: Array<{ code: string }>
    extractedDataMerge?: Record<string, unknown>
  }> = []
  const claims: Array<{ allowedStatuses: string[]; reclaimBefore: Date | null }> = []
  return {
    state,
    persists,
    markFails,
    claims,
    get draft() {
      return draft
    },
    async findDraft() {
      return { ...draft }
    },
    async findContent() {
      return state.content ? { ...state.content } : null
    },
    async findMessage() {
      return { id: "m1", subject: seed.subject ?? "Commande", receivedAt: new Date("2026-10-20T08:00:00Z") }
    },
    async listAttachmentMetadata() {
      return state.attachments.map((a) => ({ ...a }))
    },
    async claimExtracting(input: {
      expectedVersion: number
      now: Date
      allowedStatuses: string[]
      reclaimBefore: Date | null
    }) {
      claims.push({ allowedStatuses: input.allowedStatuses, reclaimBefore: input.reclaimBefore })
      if (draft.version !== input.expectedVersion) return null
      const reclaimable =
        draft.status === "EXTRACTING" &&
        input.reclaimBefore != null &&
        draft.extractionStartedAt != null &&
        draft.extractionStartedAt < input.reclaimBefore
      if (!input.allowedStatuses.includes(draft.status) && !reclaimable) return null
      draft = {
        ...draft,
        status: "EXTRACTING",
        version: draft.version + 1,
        extractionAttemptCount: draft.extractionAttemptCount + 1,
        extractionStartedAt: input.now,
      }
      return { ...draft }
    },
    async persistExtraction(input: PersistExtractionInput) {
      persists.push(input)
      if (draft.version !== input.expectedVersion || draft.status !== "EXTRACTING") return "STATE_CHANGED" as const
      const fresh =
        input.sourceKind === "ATTACHMENTS_ONLY"
          ? !hasExploitableMessageText(state.content) &&
            computeAttachmentsOnlyFingerprint({
              contentHash: state.content?.contentHash ?? null,
              attachments: state.attachments,
            }) === input.expectedContentHash
          : state.content?.contentHash === input.expectedContentHash
      if (!fresh) {
        draft = { ...draft, status: "FAILED", version: draft.version + 1 }
        return "STALE_CONTENT" as const
      }
      draft = {
        ...draft,
        status: input.status,
        version: draft.version + 1,
        contentHashAtExtraction: input.expectedContentHash,
        proposedWorksiteName: input.fields.worksiteName,
        proposedAddress: input.fields.address,
        extractedData: input.extractedData,
      }
      return "OK" as const
    },
    async markFailedWhileExtracting(input: {
      expectedVersion: number
      errorCode: string
      extractionRetryable?: boolean
      warnings?: Array<{ code: string }>
      extractedDataMerge?: Record<string, unknown>
    }) {
      markFails.push(input)
      if (draft.version !== input.expectedVersion || draft.status !== "EXTRACTING") return "STATE_CHANGED" as const
      draft = {
        ...draft,
        status: "FAILED",
        version: draft.version + 1,
        extractionRetryable: input.extractionRetryable ?? false,
        extractedData: input.extractedDataMerge
          ? { ...(draft.extractedData ?? {}), ...input.extractedDataMerge }
          : draft.extractedData,
      }
      return "OK" as const
    },
  }
}

export function storedAttachment(
  over: Partial<AttachmentMetaRow> & { filename: string }
): AttachmentMetaRow {
  return {
    id: `att-${over.filename}`,
    sha256: `sha-${over.filename}`,
    mimeType: "application/octet-stream",
    category: "UNKNOWN",
    sizeBytes: 1000,
    status: "STORED",
    storagePublicId: `pid/${over.filename}`,
    ...over,
  }
}
