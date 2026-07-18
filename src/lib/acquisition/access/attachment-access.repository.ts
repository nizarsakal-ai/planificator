import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { AttachmentAccessRepositoryPort } from "@/lib/acquisition/access/attachment-access.port"
import type {
  ConsultableAttachmentRecord,
  FindConsultableAttachmentInput,
} from "@/lib/acquisition/access/attachment-access.types"

function isComplete(row: {
  storagePublicId: string | null
  sha256: string | null
  storedAt: Date | null
}): row is { storagePublicId: string; sha256: string; storedAt: Date } {
  return Boolean(row.storagePublicId && row.sha256 && row.storedAt)
}

export class AttachmentAccessRepository implements AttachmentAccessRepositoryPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async findConsultableAttachment(
    input: FindConsultableAttachmentInput
  ): Promise<ConsultableAttachmentRecord | null> {
    if (!input.companyId || !input.attachmentId) return null

    const row = await this.db.acquisitionAttachment.findFirst({
      where: {
        id: input.attachmentId,
        companyId: input.companyId,
        status: "STORED",
      },
      select: {
        id: true,
        companyId: true,
        filename: true,
        mimeType: true,
        sizeBytes: true,
        storagePublicId: true,
        sha256: true,
        storedAt: true,
      },
    })

    if (!row || !isComplete(row)) return null

    return {
      id: row.id,
      companyId: row.companyId,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      storagePublicId: row.storagePublicId,
      sha256: row.sha256,
      storedAt: row.storedAt,
    }
  }
}

export const attachmentAccessRepository = new AttachmentAccessRepository()
