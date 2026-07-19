import type { PrismaClient } from "@prisma/client"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import type {
  MessageContentRecord,
  SanitizedMessageContent,
  UpsertMessageContentResult,
} from "@/lib/acquisition/content/message-content.types"

function mapRow(row: {
  id: string
  companyId: string
  acquisitionMessageId: string
  normalizedText: string
  contentHash: string
  sourceMimeType: string | null
  sourceCharset: string | null
  hadHtml: boolean
  byteLengthOriginal: number
  fetchedAt: Date
  sanitizedAt: Date
  createdAt: Date
  updatedAt: Date
}): MessageContentRecord {
  return { ...row }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
}

export interface UpsertMessageContentInput {
  companyId: string
  acquisitionMessageId: string
  sanitized: SanitizedMessageContent
  fetchedAt: Date
}

export class AcquisitionMessageContentRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  async findByMessage(
    companyId: string,
    acquisitionMessageId: string
  ): Promise<MessageContentRecord | null> {
    if (!companyId || !acquisitionMessageId) return null
    const row = await this.db.acquisitionMessageContent.findFirst({
      where: { companyId, acquisitionMessageId },
    })
    return row ? mapRow(row) : null
  }

  /**
   * Upsert idempotent.
   * - same hash → ALREADY_FETCHED (no write)
   * - existing different hash → UPDATED
   * - create → FETCHED
   * - P2002 concurrent create → relecture + ALREADY_FETCHED | UPDATED
   * Autres erreurs Prisma → rethrow (jamais succès silencieux).
   */
  async upsertNormalized(input: UpsertMessageContentInput): Promise<UpsertMessageContentResult> {
    const existing = await this.findByMessage(input.companyId, input.acquisitionMessageId)
    if (existing && existing.contentHash === input.sanitized.contentHash) {
      return { record: existing, outcome: "ALREADY_FETCHED" }
    }

    const data = {
      normalizedText: input.sanitized.normalizedText,
      contentHash: input.sanitized.contentHash,
      sourceMimeType: input.sanitized.sourceMimeType,
      sourceCharset: input.sanitized.sourceCharset,
      hadHtml: input.sanitized.hadHtml,
      byteLengthOriginal: input.sanitized.byteLengthOriginal,
      fetchedAt: input.fetchedAt,
      sanitizedAt: input.sanitized.sanitizedAt,
    }

    if (existing) {
      const row = await this.db.acquisitionMessageContent.update({
        where: { id: existing.id },
        data,
      })
      return { record: mapRow(row), outcome: "UPDATED" }
    }

    try {
      const row = await this.db.acquisitionMessageContent.create({
        data: {
          companyId: input.companyId,
          acquisitionMessageId: input.acquisitionMessageId,
          ...data,
        },
      })
      return { record: mapRow(row), outcome: "FETCHED" }
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error

      const raced = await this.findByMessage(input.companyId, input.acquisitionMessageId)
      if (!raced) {
        throw error
      }
      if (raced.contentHash === input.sanitized.contentHash) {
        return { record: raced, outcome: "ALREADY_FETCHED" }
      }

      const row = await this.db.acquisitionMessageContent.update({
        where: { id: raced.id },
        data,
      })
      return { record: mapRow(row), outcome: "UPDATED" }
    }
  }
}

export const acquisitionMessageContentRepository = new AcquisitionMessageContentRepository()
