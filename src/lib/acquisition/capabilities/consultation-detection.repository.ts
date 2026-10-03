/**
 * PLAN-ACQ-DETECTION-001 — Lectures / persistance Detection (TX hash-bound).
 * PLAN-ACQ-DETECTION-001-R1 — fence TX assertOwnedAndLock avant écriture AUTO.
 */

import type {
  AcquisitionConsultationClassification,
  Prisma,
  PrismaClient,
} from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { ConsultationClassification } from "@/lib/acquisition/capabilities/consultation-capability.types"
import type { DetectionAttachmentSignal } from "@/lib/acquisition/capabilities/consultation-detection.policy"
import type { TransactionalOwnershipFence } from "@/lib/acquisition/conversion/conversion-ownership-fence.port"

export type DetectionLoadSnapshot = {
  draftId: string
  companyId: string
  acquisitionMessageId: string
  draftStatus: string
  draftVersion: number
  detectionClassification: ConsultationClassification | null
  detectionContentHash: string | null
  detectionCompletedAt: Date | null
  subject: string | null
  senderEmail: string | null
  senderDomain: string | null
  resolvedPartnerId: string | null
  partnerActive: boolean
  partnerCode: string | null
  partnerPipeline: string | null
  normalizedText: string
  contentHash: string
  attachments: DetectionAttachmentSignal[]
}

export type PersistDetectionInput = {
  companyId: string
  draftId: string
  expectedVersion: number
  expectedContentHash: string
  classification: ConsultationClassification
  now: Date
  /**
   * Fence TX orchestrateur (WeakMap). Présente ⇒ assertOwnedAndLock dans la
   * même transaction que l’écriture. Absente ⇒ chemin non-AUTO (tests / manuel).
   */
  transactionalOwnershipFence?: TransactionalOwnershipFence
}

export type PersistDetectionOutcome =
  | "PERSISTED"
  | "STALE_CONTENT"
  | "STATE_CHANGED"
  | "LEASE_NOT_OWNED"

function asClassification(
  v: AcquisitionConsultationClassification | null
): ConsultationClassification | null {
  return v
}

export class ConsultationDetectionRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  async loadDetectionSnapshot(input: {
    companyId: string
    acquisitionMessageId: string
  }): Promise<DetectionLoadSnapshot | null> {
    if (!input.companyId || !input.acquisitionMessageId) return null

    const draft = await this.db.worksiteImportDraft.findFirst({
      where: {
        companyId: input.companyId,
        acquisitionMessageId: input.acquisitionMessageId,
      },
      select: {
        id: true,
        companyId: true,
        acquisitionMessageId: true,
        status: true,
        version: true,
        detectionClassification: true,
        detectionContentHash: true,
        detectionCompletedAt: true,
      },
    })
    if (!draft) return null

    const message = await this.db.acquisitionMessage.findFirst({
      where: { id: input.acquisitionMessageId, companyId: input.companyId },
      select: {
        subject: true,
        senderEmail: true,
        senderDomain: true,
        resolvedPartnerId: true,
      },
    })
    if (!message) return null

    const content = await this.db.acquisitionMessageContent.findFirst({
      where: {
        companyId: input.companyId,
        acquisitionMessageId: input.acquisitionMessageId,
      },
      select: { normalizedText: true, contentHash: true },
    })
    if (!content || !content.normalizedText.trim()) return null

    let partnerActive = false
    let partnerCode: string | null = null
    let partnerPipeline: string | null = null
    if (message.resolvedPartnerId) {
      const partner = await this.db.acquisitionPartner.findFirst({
        where: {
          id: message.resolvedPartnerId,
          companyId: input.companyId,
        },
        select: { active: true, code: true, pipeline: true },
      })
      partnerActive = partner?.active === true
      partnerCode = partner?.code ?? null
      partnerPipeline = partner?.pipeline ?? null
    }

    const attachments = await this.db.acquisitionAttachment.findMany({
      where: {
        companyId: input.companyId,
        acquisitionMessageId: input.acquisitionMessageId,
      },
      select: { filename: true, mimeType: true, category: true },
      take: 50,
      orderBy: { createdAt: "asc" },
    })

    return {
      draftId: draft.id,
      companyId: draft.companyId,
      acquisitionMessageId: draft.acquisitionMessageId,
      draftStatus: draft.status,
      draftVersion: draft.version,
      detectionClassification: asClassification(draft.detectionClassification),
      detectionContentHash: draft.detectionContentHash,
      detectionCompletedAt: draft.detectionCompletedAt,
      subject: message.subject,
      senderEmail: message.senderEmail,
      senderDomain: message.senderDomain,
      resolvedPartnerId: message.resolvedPartnerId,
      partnerActive,
      partnerCode,
      partnerPipeline,
      normalizedText: content.normalizedText,
      contentHash: content.contentHash,
      attachments: attachments.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        category: a.category,
      })),
    }
  }

  /**
   * Persistance hash-bound + fence TX optionnelle (AUTO) :
   * 1) relire contentHash courant
   * 2) si diverge → aucune preuve écrite (STALE_CONTENT)
   * 3) si fence → assertOwnedAndLock(tx) immédiatement avant update
   * 4) sinon update versionné companyId+draftId+version
   */
  async persistDetectionProof(
    input: PersistDetectionInput
  ): Promise<PersistDetectionOutcome> {
    return this.db.$transaction(async (tx) => {
      const draft = await tx.worksiteImportDraft.findFirst({
        where: { id: input.draftId, companyId: input.companyId },
        select: {
          version: true,
          acquisitionMessageId: true,
        },
      })
      if (!draft || draft.version !== input.expectedVersion) {
        return "STATE_CHANGED" as const
      }

      const content = await tx.acquisitionMessageContent.findFirst({
        where: {
          companyId: input.companyId,
          acquisitionMessageId: draft.acquisitionMessageId,
        },
        select: { contentHash: true },
      })
      if (!content || content.contentHash !== input.expectedContentHash) {
        return "STALE_CONTENT" as const
      }

      const fence = input.transactionalOwnershipFence
      if (fence) {
        const owned = await fence.assertOwnedAndLock(tx)
        if (owned !== "OWNED") {
          return "LEASE_NOT_OWNED" as const
        }
      }

      const updated = await tx.worksiteImportDraft.updateMany({
        where: {
          id: input.draftId,
          companyId: input.companyId,
          version: input.expectedVersion,
        },
        data: {
          detectionClassification:
            input.classification as AcquisitionConsultationClassification,
          detectionContentHash: input.expectedContentHash,
          detectionCompletedAt: input.now,
          version: { increment: 1 },
        },
      })

      return updated.count === 1
        ? ("PERSISTED" as const)
        : ("STATE_CHANGED" as const)
    })
  }
}

export const consultationDetectionRepository = new ConsultationDetectionRepository()

/** Preuve valide pour extraction AUTO (hash courant + classification autorisée). */
export function detectionProofMatchesContent(input: {
  detectionClassification: ConsultationClassification | null | undefined
  detectionContentHash: string | null | undefined
  currentContentHash: string
  authorized: (c: ConsultationClassification | null | undefined) => boolean
}): boolean {
  if (!input.detectionContentHash || !input.currentContentHash) return false
  if (input.detectionContentHash !== input.currentContentHash) return false
  return input.authorized(input.detectionClassification)
}

export type DetectionDraftProofRow = {
  detectionClassification: ConsultationClassification | null
  detectionContentHash: string | null
}

export async function loadDraftDetectionProof(
  db: PrismaClient | Prisma.TransactionClient,
  companyId: string,
  draftId: string
): Promise<DetectionDraftProofRow | null> {
  const row = await db.worksiteImportDraft.findFirst({
    where: { id: draftId, companyId },
    select: {
      detectionClassification: true,
      detectionContentHash: true,
    },
  })
  if (!row) return null
  return {
    detectionClassification: asClassification(row.detectionClassification),
    detectionContentHash: row.detectionContentHash,
  }
}
