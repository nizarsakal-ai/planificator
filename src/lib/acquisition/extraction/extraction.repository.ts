/**
 * PLAN-ACQ-005B — Repository draft extraction (Prisma isolé ici).
 * Persist atomique : TX courte = relecture hash + update versionné.
 */

import type { PrismaClient, WorksiteImportDraftStatus } from "@prisma/client"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { EXTRACTION_SCHEMA_VERSION } from "@/lib/acquisition/extraction/extraction-feature-flag"
import type {
  ExtractionCanonicalFields,
  ExtractionWarning,
} from "@/lib/acquisition/extraction/extraction.types"

export type DraftExtractionRow = {
  id: string
  companyId: string
  acquisitionMessageId: string
  status: WorksiteImportDraftStatus
  version: number
  extractionAttemptCount: number
  extractionStartedAt: Date | null
  contentHashAtExtraction: string | null
  extractionSchemaVersion: string | null
}

export type MessageContentLite = {
  normalizedText: string
  contentHash: string
}

export type MessageLite = {
  id: string
  subject: string | null
}

export type AttachmentMetaRow = {
  filename: string
  mimeType: string
  category: string
  sizeBytes: number
}

export type ClaimDraftInput = {
  companyId: string
  draftId: string
  expectedVersion: number
  allowedStatuses: WorksiteImportDraftStatus[]
  now: Date
  reclaimBefore: Date | null
}

export type PersistExtractionInput = {
  companyId: string
  draftId: string
  expectedVersion: number
  /** Hash figé au claim — vérifié atomiquement dans la TX. */
  expectedContentHash: string
  status: "PENDING_REVIEW" | "FAILED"
  fields: ExtractionCanonicalFields
  confidenceData: Record<string, number>
  warningData: ExtractionWarning[]
  extractedData: Record<string, unknown>
  providerId: string
  model: string | null
  errorCode: string | null
  now: Date
}

export type PersistExtractionOutcome = "OK" | "STALE_CONTENT" | "STATE_CHANGED"

export type MarkFailedOutcome = "OK" | "STATE_CHANGED"

export class DraftExtractionRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  async findDraft(companyId: string, draftId: string): Promise<DraftExtractionRow | null> {
    if (!companyId || !draftId) return null
    const row = await this.db.worksiteImportDraft.findFirst({
      where: { id: draftId, companyId },
      select: {
        id: true,
        companyId: true,
        acquisitionMessageId: true,
        status: true,
        version: true,
        extractionAttemptCount: true,
        extractionStartedAt: true,
        contentHashAtExtraction: true,
        extractionSchemaVersion: true,
      },
    })
    return row
  }

  async findContent(
    companyId: string,
    acquisitionMessageId: string
  ): Promise<MessageContentLite | null> {
    const row = await this.db.acquisitionMessageContent.findFirst({
      where: { companyId, acquisitionMessageId },
      select: { normalizedText: true, contentHash: true },
    })
    return row
  }

  async findMessage(companyId: string, messageId: string): Promise<MessageLite | null> {
    const row = await this.db.acquisitionMessage.findFirst({
      where: { id: messageId, companyId },
      select: { id: true, subject: true },
    })
    return row
  }

  async listAttachmentMetadata(
    companyId: string,
    acquisitionMessageId: string
  ): Promise<AttachmentMetaRow[]> {
    const rows = await this.db.acquisitionAttachment.findMany({
      where: { companyId, acquisitionMessageId },
      select: { filename: true, mimeType: true, category: true, sizeBytes: true },
      take: 50,
      orderBy: { createdAt: "asc" },
    })
    return rows.map((r) => ({
      filename: r.filename,
      mimeType: r.mimeType,
      category: r.category,
      sizeBytes: r.sizeBytes,
    }))
  }

  /**
   * Claim atomique : status → EXTRACTING, version++, attemptCount++, startedAt.
   * Inclut reclaim si EXTRACTING et extractionStartedAt < reclaimBefore.
   */
  async claimExtracting(input: ClaimDraftInput): Promise<DraftExtractionRow | null> {
    const statusFilter: Prisma.WorksiteImportDraftWhereInput = input.reclaimBefore
      ? {
          OR: [
            { status: { in: input.allowedStatuses } },
            {
              status: "EXTRACTING",
              extractionStartedAt: { lt: input.reclaimBefore },
            },
          ],
        }
      : { status: { in: input.allowedStatuses } }

    const updated = await this.db.worksiteImportDraft.updateMany({
      where: {
        id: input.draftId,
        companyId: input.companyId,
        version: input.expectedVersion,
        ...statusFilter,
      },
      data: {
        status: "EXTRACTING",
        version: { increment: 1 },
        extractionAttemptCount: { increment: 1 },
        extractionStartedAt: input.now,
        extractionCompletedAt: null,
        lastExtractionErrorCode: null,
        lastExtractionErrorAt: null,
      },
    })

    if (updated.count === 0) return null

    return this.findDraft(input.companyId, input.draftId)
  }

  /**
   * Persist atomique (TX courte, hors provider) :
   * 1) relire content hash tenant-scopé
   * 2) si diverge → FAILED STALE_CONTENT (si encore EXTRACTING+version) ou STATE_CHANGED
   * 3) sinon update draft avec prédicat id+companyId+EXTRACTING+version
   */
  async persistExtraction(input: PersistExtractionInput): Promise<PersistExtractionOutcome> {
    const fields = input.fields
    const startDate = fields.requestedStartDate
      ? new Date(`${fields.requestedStartDate}T00:00:00.000Z`)
      : null
    const endDate = fields.requestedEndDate
      ? new Date(`${fields.requestedEndDate}T00:00:00.000Z`)
      : null

    return this.db.$transaction(async (tx) => {
      const draftLite = await tx.worksiteImportDraft.findFirst({
        where: { id: input.draftId, companyId: input.companyId },
        select: { acquisitionMessageId: true },
      })
      if (!draftLite) return "STATE_CHANGED" as const

      const contentFresh = await tx.acquisitionMessageContent.findFirst({
        where: {
          companyId: input.companyId,
          acquisitionMessageId: draftLite.acquisitionMessageId,
        },
        select: { contentHash: true },
      })

      if (!contentFresh || contentFresh.contentHash !== input.expectedContentHash) {
        const staleMark = await tx.worksiteImportDraft.updateMany({
          where: {
            id: input.draftId,
            companyId: input.companyId,
            version: input.expectedVersion,
            status: "EXTRACTING",
          },
          data: {
            status: "FAILED",
            version: { increment: 1 },
            extractionCompletedAt: input.now,
            lastExtractionErrorCode: "STALE_CONTENT",
            lastExtractionErrorAt: input.now,
            warningData: [] as unknown as Prisma.InputJsonValue,
          },
        })
        return staleMark.count === 1 ? ("STALE_CONTENT" as const) : ("STATE_CHANGED" as const)
      }

      const updated = await tx.worksiteImportDraft.updateMany({
        where: {
          id: input.draftId,
          companyId: input.companyId,
          version: input.expectedVersion,
          status: "EXTRACTING",
        },
        data: {
          status: input.status,
          version: { increment: 1 },
          proposedClientName: fields.clientName,
          proposedWorksiteName: fields.worksiteName,
          proposedAddress: fields.address,
          proposedContactName: fields.contactName,
          proposedContactEmail: fields.clientEmail ?? fields.contactEmail,
          proposedContactPhone: fields.clientPhone ?? fields.contactPhone,
          proposedStartDate: startDate,
          proposedEndDate: endDate,
          proposedDescription: fields.description,
          extractedData: input.extractedData as Prisma.InputJsonValue,
          confidenceData: input.confidenceData as Prisma.InputJsonValue,
          warningData: input.warningData as unknown as Prisma.InputJsonValue,
          extractionCompletedAt: input.now,
          contentHashAtExtraction: input.expectedContentHash,
          extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION,
          extractionProvider: input.providerId,
          extractionModel: input.model,
          lastExtractionErrorCode: input.errorCode,
          lastExtractionErrorAt: input.errorCode ? input.now : null,
        },
      })

      return updated.count === 1 ? ("OK" as const) : ("STATE_CHANGED" as const)
    })
  }

  async markFailedWhileExtracting(input: {
    companyId: string
    draftId: string
    expectedVersion: number
    errorCode: string
    now: Date
    warnings?: ExtractionWarning[]
  }): Promise<MarkFailedOutcome> {
    const updated = await this.db.worksiteImportDraft.updateMany({
      where: {
        id: input.draftId,
        companyId: input.companyId,
        version: input.expectedVersion,
        status: "EXTRACTING",
      },
      data: {
        status: "FAILED",
        version: { increment: 1 },
        extractionCompletedAt: input.now,
        lastExtractionErrorCode: input.errorCode,
        lastExtractionErrorAt: input.now,
        warningData: (input.warnings ?? []) as unknown as Prisma.InputJsonValue,
      },
    })
    return updated.count === 1 ? "OK" : "STATE_CHANGED"
  }
}

export const draftExtractionRepository = new DraftExtractionRepository()
