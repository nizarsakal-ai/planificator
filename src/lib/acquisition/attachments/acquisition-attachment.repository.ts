import type { AcquisitionAttachmentStatus, PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type {
  AttachmentFailureUpdate,
  AttachmentMessageContext,
  AttachmentRecord,
  ClaimForDownloadResult,
  MarkStoredResult,
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
  ): Promise<AttachmentRecord>
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

    const updated = await this.db.acquisitionAttachment.updateMany({
      where: {
        id: attachmentId,
        companyId,
        status: "DISCOVERED",
      },
      data: { status: "PENDING_DOWNLOAD" },
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
  ): Promise<AttachmentRecord> {
    const result = await this.db.acquisitionAttachment.updateMany({
      where: { id: attachmentId, companyId },
      data: {
        status: update.status,
        lastErrorCode: update.errorCode,
        lastErrorAt: update.failedAt,
        storageUrl: null,
        storagePublicId: null,
      },
    })
    if (result.count === 0) throw new Error("ATTACHMENT_NOT_FOUND")
    const row = await this.db.acquisitionAttachment.findFirstOrThrow({
      where: { id: attachmentId, companyId },
    })
    return mapRecord(row)
  }
}

export const acquisitionAttachmentRepository = new AcquisitionAttachmentRepository()
