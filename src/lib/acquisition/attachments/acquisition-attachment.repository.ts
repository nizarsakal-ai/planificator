import type { AcquisitionAttachmentStatus, PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type {
  AttachmentFailureUpdate,
  AttachmentMessageContext,
  AttachmentRecord,
  ClaimForDownloadResult,
  MarkFailureResult,
  MarkStoredResult,
  ReclaimPendingDownloadResult,
  ScheduleRetryToDiscoveredResult,
  StoredAttachmentUpdate,
} from "@/lib/acquisition/attachments/attachment.types"

export interface AcquisitionAttachmentRepositoryPort {
  findAttachmentWithMessage(
    companyId: string,
    attachmentId: string
  ): Promise<{ attachment: AttachmentRecord; message: AttachmentMessageContext } | null>
  claimForDownload(companyId: string, attachmentId: string): Promise<ClaimForDownloadResult>
  markStored(
    companyId: string,
    attachmentId: string,
    update: StoredAttachmentUpdate
  ): Promise<MarkStoredResult>
  markFailure(
    companyId: string,
    attachmentId: string,
    update: AttachmentFailureUpdate
  ): Promise<MarkFailureResult>
  listCompanyIdsWithDiscoveredAttachments(input: { limit: number }): Promise<string[]>
  listDiscoveredAttachmentsForCompany(input: {
    companyId: string
    limit: number
  }): Promise<Array<{ id: string; companyId: string; createdAt: Date }>>
  listCompanyIdsWithReclaimCandidates(input: {
    olderThan: Date
    limit: number
  }): Promise<string[]>
  listPendingDownloadsForReclaim(input: {
    companyId: string
    olderThan: Date
    limit: number
  }): Promise<Array<{ id: string; companyId: string; downloadClaimedAt: Date }>>
  listCompanyIdsWithRetryCandidates(input: {
    now: Date
    maxRetries: number
    limit: number
  }): Promise<string[]>
  listFailedAttachmentsForRetry(input: {
    companyId: string
    now: Date
    limit: number
    maxRetries: number
    retryableErrorCodes: string[]
  }): Promise<
    Array<{
      id: string
      companyId: string
      downloadRetryCount: number
      lastErrorCode: string | null
    }>
  >
  reclaimPendingDownload(input: {
    companyId: string
    attachmentId: string
    olderThan: Date
  }): Promise<ReclaimPendingDownloadResult>
  scheduleRetryToDiscovered(input: {
    companyId: string
    attachmentId: string
    now: Date
    maxRetries: number
    retryableErrorCodes: string[]
  }): Promise<ScheduleRetryToDiscoveredResult>
}

function mapRecord(row: {
  id: string
  companyId: string
  acquisitionMessageId: string
  externalAttachmentId: string | null
  filename: string
  mimeType: string
  sizeBytes: number
  status: AcquisitionAttachmentStatus
  sha256: string | null
  storageUrl: string | null
  storagePublicId: string | null
  storedAt: Date | null
  lastErrorCode: string | null
  downloadClaimedAt: Date | null
  downloadRetryCount: number
  downloadNextRetryAt: Date | null
}): AttachmentRecord {
  return { ...row, status: row.status }
}

function isCompleteStored(attachment: AttachmentRecord): boolean {
  return attachment.status === "STORED" && Boolean(attachment.sha256 && attachment.storagePublicId)
}

/** Accès Prisma tenant-scopé pour les pièces jointes Acquisition. */
export class AcquisitionAttachmentRepository implements AcquisitionAttachmentRepositoryPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async findAttachmentWithMessage(
    companyId: string,
    attachmentId: string
  ): Promise<{ attachment: AttachmentRecord; message: AttachmentMessageContext } | null> {
    if (!companyId || !attachmentId) return null

    const row = await this.db.acquisitionAttachment.findFirst({
      where: { id: attachmentId, companyId },
      include: {
        acquisitionMessage: {
          select: { id: true, companyId: true, externalMessageId: true },
        },
      },
    })
    if (!row) return null
    if (row.acquisitionMessage.companyId !== companyId) return null

    return {
      attachment: mapRecord(row),
      message: row.acquisitionMessage,
    }
  }

  async claimForDownload(companyId: string, attachmentId: string): Promise<ClaimForDownloadResult> {
    const resolveLatest = async (): Promise<ClaimForDownloadResult> => {
      const latest = await this.findAttachmentWithMessage(companyId, attachmentId)
      if (!latest) return { status: "NOT_FOUND" }
      if (isCompleteStored(latest.attachment)) {
        return { status: "ALREADY_STORED", attachment: latest.attachment }
      }
      if (latest.attachment.status === "PENDING_DOWNLOAD") {
        return { status: "ALREADY_IN_PROGRESS" }
      }
      if (latest.attachment.status === "FAILED" || latest.attachment.status === "REJECTED") {
        return { status: "NOT_RETRYABLE", attachment: latest.attachment }
      }
      return { status: "NOT_FOUND" }
    }

    const current = await this.findAttachmentWithMessage(companyId, attachmentId)
    if (!current) return { status: "NOT_FOUND" }

    if (isCompleteStored(current.attachment)) {
      return { status: "ALREADY_STORED", attachment: current.attachment }
    }
    if (current.attachment.status === "PENDING_DOWNLOAD") {
      return { status: "ALREADY_IN_PROGRESS" }
    }
    if (current.attachment.status === "FAILED" || current.attachment.status === "REJECTED") {
      return { status: "NOT_RETRYABLE", attachment: current.attachment }
    }
    if (current.attachment.status !== "DISCOVERED") {
      return { status: "NOT_FOUND" }
    }

    const claimedAt = new Date()
    const updated = await this.db.acquisitionAttachment.updateMany({
      where: {
        id: attachmentId,
        companyId,
        status: "DISCOVERED",
      },
      data: {
        status: "PENDING_DOWNLOAD",
        downloadClaimedAt: claimedAt,
      },
    })

    if (updated.count === 1) {
      const row = await this.db.acquisitionAttachment.findFirst({
        where: { id: attachmentId, companyId },
      })
      if (!row) return { status: "NOT_FOUND" }
      return { status: "CLAIMED", attachment: mapRecord(row) }
    }

    return resolveLatest()
  }

  async markStored(
    companyId: string,
    attachmentId: string,
    update: StoredAttachmentUpdate
  ): Promise<MarkStoredResult> {
    const result = await this.db.acquisitionAttachment.updateMany({
      where: { id: attachmentId, companyId, status: "PENDING_DOWNLOAD" },
      data: {
        status: "STORED",
        sha256: update.sha256,
        storageUrl: update.storageUrl,
        storagePublicId: update.storagePublicId,
        storedAt: update.storedAt,
        sizeBytes: update.sizeBytes,
        mimeType: update.mimeType,
        lastErrorCode: null,
        lastErrorAt: null,
        downloadClaimedAt: null,
        downloadNextRetryAt: null,
      },
    })

    if (result.count === 1) {
      const row = await this.db.acquisitionAttachment.findFirstOrThrow({
        where: { id: attachmentId, companyId },
      })
      return { status: "STORED", attachment: mapRecord(row) }
    }

    const latest = await this.findAttachmentWithMessage(companyId, attachmentId)
    if (latest && isCompleteStored(latest.attachment)) {
      return { status: "ALREADY_STORED", attachment: latest.attachment }
    }

    return { status: "FAILED" }
  }

  async markFailure(
    companyId: string,
    attachmentId: string,
    update: AttachmentFailureUpdate
  ): Promise<MarkFailureResult> {
    if (!companyId || !attachmentId) return { outcome: "NOT_FOUND" }

    const data =
      update.status === "REJECTED"
        ? {
            status: "REJECTED" as const,
            lastErrorCode: update.errorCode,
            lastErrorAt: update.failedAt,
            storageUrl: null,
            storagePublicId: null,
            downloadClaimedAt: null,
            downloadNextRetryAt: null,
          }
        : {
            status: "FAILED" as const,
            lastErrorCode: update.errorCode,
            lastErrorAt: update.failedAt,
            storageUrl: null,
            storagePublicId: null,
            downloadClaimedAt: null,
            downloadNextRetryAt: update.nextRetryAt ?? null,
            downloadRetryCount: { increment: 1 },
          }

    const result = await this.db.acquisitionAttachment.updateMany({
      where: { id: attachmentId, companyId, status: "PENDING_DOWNLOAD" },
      data,
    })

    if (result.count === 1) {
      const row = await this.db.acquisitionAttachment.findFirstOrThrow({
        where: { id: attachmentId, companyId },
      })
      const attachment = mapRecord(row)
      return update.status === "REJECTED"
        ? { outcome: "MARKED_REJECTED", attachment }
        : { outcome: "MARKED_FAILED", attachment }
    }

    const latest = await this.db.acquisitionAttachment.findFirst({
      where: { id: attachmentId, companyId },
      select: { id: true },
    })
    if (!latest) return { outcome: "NOT_FOUND" }
    return { outcome: "STATE_CHANGED" }
  }

  async listCompanyIdsWithDiscoveredAttachments(input: { limit: number }): Promise<string[]> {
    const limit = Math.max(0, Math.floor(input.limit))
    if (limit === 0) return []

    const rows = await this.db.acquisitionAttachment.findMany({
      where: { status: "DISCOVERED" },
      distinct: ["companyId"],
      select: { companyId: true },
      orderBy: { companyId: "asc" },
      take: limit,
    })
    return rows.map((row) => row.companyId)
  }

  async listDiscoveredAttachmentsForCompany(input: {
    companyId: string
    limit: number
  }): Promise<Array<{ id: string; companyId: string; createdAt: Date }>> {
    if (!input.companyId) return []
    const limit = Math.max(0, Math.floor(input.limit))
    if (limit === 0) return []

    return this.db.acquisitionAttachment.findMany({
      where: { companyId: input.companyId, status: "DISCOVERED" },
      select: { id: true, companyId: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
    })
  }

  async listCompanyIdsWithReclaimCandidates(input: {
    olderThan: Date
    limit: number
  }): Promise<string[]> {
    const limit = Math.max(0, Math.floor(input.limit))
    if (limit === 0) return []

    const rows = await this.db.acquisitionAttachment.findMany({
      where: {
        status: "PENDING_DOWNLOAD",
        downloadClaimedAt: { not: null, lte: input.olderThan },
      },
      distinct: ["companyId"],
      select: { companyId: true },
      orderBy: { companyId: "asc" },
      take: limit,
    })
    return rows.map((row) => row.companyId)
  }

  async listPendingDownloadsForReclaim(input: {
    companyId: string
    olderThan: Date
    limit: number
  }): Promise<Array<{ id: string; companyId: string; downloadClaimedAt: Date }>> {
    if (!input.companyId) return []
    const limit = Math.max(0, Math.floor(input.limit))
    if (limit === 0) return []

    const rows = await this.db.acquisitionAttachment.findMany({
      where: {
        companyId: input.companyId,
        status: "PENDING_DOWNLOAD",
        downloadClaimedAt: { not: null, lte: input.olderThan },
      },
      select: { id: true, companyId: true, downloadClaimedAt: true },
      orderBy: [{ downloadClaimedAt: "asc" }, { id: "asc" }],
      take: limit,
    })

    return rows
      .filter((row): row is typeof row & { downloadClaimedAt: Date } => row.downloadClaimedAt != null)
      .map((row) => ({
        id: row.id,
        companyId: row.companyId,
        downloadClaimedAt: row.downloadClaimedAt,
      }))
  }

  async listCompanyIdsWithRetryCandidates(input: {
    now: Date
    maxRetries: number
    limit: number
  }): Promise<string[]> {
    const limit = Math.max(0, Math.floor(input.limit))
    if (limit === 0) return []

    const rows = await this.db.acquisitionAttachment.findMany({
      where: {
        status: "FAILED",
        downloadNextRetryAt: { not: null, lte: input.now },
        downloadRetryCount: { lte: input.maxRetries },
      },
      distinct: ["companyId"],
      select: { companyId: true },
      orderBy: { companyId: "asc" },
      take: limit,
    })
    return rows.map((row) => row.companyId)
  }

  async listFailedAttachmentsForRetry(input: {
    companyId: string
    now: Date
    limit: number
    maxRetries: number
    retryableErrorCodes: string[]
  }): Promise<
    Array<{
      id: string
      companyId: string
      downloadRetryCount: number
      lastErrorCode: string | null
    }>
  > {
    if (!input.companyId) return []
    const limit = Math.max(0, Math.floor(input.limit))
    if (limit === 0) return []
    if (input.retryableErrorCodes.length === 0) return []

    return this.db.acquisitionAttachment.findMany({
      where: {
        companyId: input.companyId,
        status: "FAILED",
        downloadNextRetryAt: { not: null, lte: input.now },
        downloadRetryCount: { lte: input.maxRetries },
        lastErrorCode: { in: input.retryableErrorCodes },
      },
      select: {
        id: true,
        companyId: true,
        downloadRetryCount: true,
        lastErrorCode: true,
      },
      orderBy: [{ downloadNextRetryAt: "asc" }, { id: "asc" }],
      take: limit,
    })
  }

  async reclaimPendingDownload(input: {
    companyId: string
    attachmentId: string
    olderThan: Date
  }): Promise<ReclaimPendingDownloadResult> {
    if (!input.companyId || !input.attachmentId) return "NOOP"

    const result = await this.db.acquisitionAttachment.updateMany({
      where: {
        id: input.attachmentId,
        companyId: input.companyId,
        status: "PENDING_DOWNLOAD",
        downloadClaimedAt: { not: null, lte: input.olderThan },
      },
      data: {
        status: "DISCOVERED",
        downloadClaimedAt: null,
      },
    })

    return result.count === 1 ? "RECLAIMED" : "NOOP"
  }

  async scheduleRetryToDiscovered(input: {
    companyId: string
    attachmentId: string
    now: Date
    maxRetries: number
    retryableErrorCodes: string[]
  }): Promise<ScheduleRetryToDiscoveredResult> {
    if (!input.companyId || !input.attachmentId) return "NOOP"
    if (input.retryableErrorCodes.length === 0) return "NOOP"

    const result = await this.db.acquisitionAttachment.updateMany({
      where: {
        id: input.attachmentId,
        companyId: input.companyId,
        status: "FAILED",
        downloadNextRetryAt: { not: null, lte: input.now },
        downloadRetryCount: { lte: input.maxRetries },
        lastErrorCode: { in: input.retryableErrorCodes },
      },
      data: {
        status: "DISCOVERED",
        downloadNextRetryAt: null,
        downloadClaimedAt: null,
      },
    })

    return result.count === 1 ? "TRANSITIONED" : "NOOP"
  }
}

export const acquisitionAttachmentRepository = new AcquisitionAttachmentRepository()
