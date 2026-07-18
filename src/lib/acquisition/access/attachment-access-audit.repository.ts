import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type { AttachmentAccessAuditRepositoryPort } from "@/lib/acquisition/access/attachment-access.port"
import type { AttachmentAccessAuditEntry } from "@/lib/acquisition/access/attachment-access.types"

export class AttachmentAccessAuditRepository implements AttachmentAccessAuditRepositoryPort {
  constructor(private readonly db: PrismaClient = prisma) {}

  async record(entry: AttachmentAccessAuditEntry): Promise<void> {
    await this.db.acquisitionAttachmentAccessLog.create({
      data: {
        companyId: entry.companyId,
        attachmentId: entry.attachmentId,
        requestedAttachmentId: entry.requestedAttachmentId,
        userId: entry.userId,
        action: entry.action,
        outcome: entry.outcome,
        reasonCode: entry.reasonCode,
      },
    })
  }
}

export const attachmentAccessAuditRepository = new AttachmentAccessAuditRepository()
