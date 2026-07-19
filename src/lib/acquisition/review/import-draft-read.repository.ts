/**
 * PLAN-ACQ-005C-MVP — Lectures tenant-scopées pour revue.
 */

import type { PrismaClient, WorksiteImportDraftStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type {
  ImportDraftListItem,
  ImportDraftReviewBundle,
  ImportDraftStatusSnapshot,
} from "@/lib/acquisition/review/import-draft-review.types"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 50

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(limit), MAX_LIMIT)
}

export class ImportDraftReadRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  async listImportDraftsForReview(input: {
    companyId: string
    status?: WorksiteImportDraftStatus
    limit?: number
  }): Promise<ImportDraftListItem[]> {
    if (!input.companyId) return []
    const rows = await this.db.worksiteImportDraft.findMany({
      where: {
        companyId: input.companyId,
        ...(input.status ? { status: input.status } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: clampLimit(input.limit),
      select: {
        id: true,
        status: true,
        version: true,
        proposedWorksiteName: true,
        lastExtractionErrorCode: true,
        updatedAt: true,
        acquisitionMessage: {
          select: {
            subject: true,
            senderEmail: true,
            receivedAt: true,
          },
        },
      },
    })

    return rows.map((r) => ({
      draftId: r.id,
      status: r.status,
      version: r.version,
      proposedWorksiteName: r.proposedWorksiteName,
      lastExtractionErrorCode: r.lastExtractionErrorCode,
      updatedAt: r.updatedAt,
      message: {
        subject: r.acquisitionMessage.subject,
        senderEmail: r.acquisitionMessage.senderEmail,
        receivedAt: r.acquisitionMessage.receivedAt,
      },
    }))
  }

  /**
   * Lecture minimale pour re-extract (statut uniquement).
   * Cross-tenant / inexistant → null.
   */
  async getImportDraftStatusForReview(input: {
    companyId: string
    draftId: string
  }): Promise<ImportDraftStatusSnapshot | null> {
    if (!input.companyId || !input.draftId) return null
    const row = await this.db.worksiteImportDraft.findFirst({
      where: { id: input.draftId, companyId: input.companyId },
      select: { id: true, status: true, version: true },
    })
    return row
  }

  /**
   * Bundle détail. Cross-tenant / inexistant → null (indifférenciable).
   * Aucun champ storage / URL / token.
   */
  async getImportDraftReviewBundle(input: {
    companyId: string
    draftId: string
  }): Promise<ImportDraftReviewBundle | null> {
    if (!input.companyId || !input.draftId) return null

    const draft = await this.db.worksiteImportDraft.findFirst({
      where: { id: input.draftId, companyId: input.companyId },
      select: {
        id: true,
        status: true,
        version: true,
        proposedWorksiteName: true,
        proposedClientName: true,
        proposedAddress: true,
        proposedPostalCode: true,
        proposedCity: true,
        proposedStartDate: true,
        proposedEndDate: true,
        proposedDescription: true,
        proposedContactName: true,
        proposedContactEmail: true,
        proposedContactPhone: true,
        confidenceData: true,
        warningData: true,
        extractionProvider: true,
        extractionModel: true,
        lastExtractionErrorCode: true,
        reviewedByUserId: true,
        reviewedAt: true,
        rejectionReason: true,
        updatedAt: true,
        acquisitionMessageId: true,
        acquisitionMessage: {
          select: {
            id: true,
            senderEmail: true,
            subject: true,
            receivedAt: true,
          },
        },
      },
    })

    if (!draft) return null

    const [content, attachments] = await Promise.all([
      this.db.acquisitionMessageContent.findFirst({
        where: {
          companyId: input.companyId,
          acquisitionMessageId: draft.acquisitionMessageId,
        },
        select: { normalizedText: true },
      }),
      this.db.acquisitionAttachment.findMany({
        where: {
          companyId: input.companyId,
          acquisitionMessageId: draft.acquisitionMessageId,
        },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          category: true,
          sizeBytes: true,
          status: true,
        },
      }),
    ])

    return {
      draft: {
        id: draft.id,
        status: draft.status,
        version: draft.version,
        proposedWorksiteName: draft.proposedWorksiteName,
        proposedClientName: draft.proposedClientName,
        proposedAddress: draft.proposedAddress,
        proposedPostalCode: draft.proposedPostalCode,
        proposedCity: draft.proposedCity,
        proposedStartDate: draft.proposedStartDate,
        proposedEndDate: draft.proposedEndDate,
        proposedDescription: draft.proposedDescription,
        proposedContactName: draft.proposedContactName,
        proposedContactEmail: draft.proposedContactEmail,
        proposedContactPhone: draft.proposedContactPhone,
        confidenceData: draft.confidenceData,
        warningData: draft.warningData,
        extractionProvider: draft.extractionProvider,
        extractionModel: draft.extractionModel,
        lastExtractionErrorCode: draft.lastExtractionErrorCode,
        reviewedByUserId: draft.reviewedByUserId,
        reviewedAt: draft.reviewedAt,
        rejectionReason: draft.rejectionReason,
        updatedAt: draft.updatedAt,
      },
      message: {
        id: draft.acquisitionMessage.id,
        senderEmail: draft.acquisitionMessage.senderEmail,
        subject: draft.acquisitionMessage.subject,
        receivedAt: draft.acquisitionMessage.receivedAt,
      },
      content: {
        normalizedText: content?.normalizedText ?? null,
      },
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        category: a.category,
        sizeBytes: a.sizeBytes,
        status: a.status,
      })),
    }
  }
}

export const importDraftReadRepository = new ImportDraftReadRepository()
