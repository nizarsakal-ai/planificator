/**
 * PLAN-ACQ-DETECTION-001 — Sélection bornée des drafts à détecter.
 * Contenu présent ; preuve absente OU hash Detection ≠ contentHash courant.
 */

import type { PrismaClient } from "@prisma/client"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export type ConsultationDetectionCandidate = {
  draftId: string
  companyId: string
  acquisitionMessageId: string
  version: number
  createdAt: Date
  updatedAt: Date
}

export interface ConsultationDetectionSelectionRepository {
  listCompanyIdsNeedingDetection(input: {
    limit: number
  }): Promise<string[]>
  listCandidatesForCompany(input: {
    companyId: string
    limit: number
  }): Promise<ConsultationDetectionCandidate[]>
}

type CandidateRow = {
  id: string
  companyId: string
  acquisitionMessageId: string
  version: number
  createdAt: Date
  updatedAt: Date
}

const NEED_DETECTION_SQL = Prisma.sql`
  c."normalizedText" <> ''
  AND (
    d."detectionContentHash" IS NULL
    OR d."detectionContentHash" <> c."contentHash"
  )
  AND d."status" IN (
    CAST('PENDING_EXTRACTION' AS "WorksiteImportDraftStatus"),
    CAST('FAILED' AS "WorksiteImportDraftStatus"),
    CAST('EXTRACTING' AS "WorksiteImportDraftStatus")
  )
`

export class AcquisitionConsultationDetectionSelectionRepository
  implements ConsultationDetectionSelectionRepository
{
  constructor(private readonly db: PrismaClient = prisma) {}

  async listCompanyIdsNeedingDetection(input: {
    limit: number
  }): Promise<string[]> {
    const limit = Math.max(1, Math.floor(input.limit))
    const rows = await this.db.$queryRaw<Array<{ companyId: string }>>`
      SELECT d."companyId" AS "companyId"
      FROM "worksite_import_drafts" d
      INNER JOIN "acquisition_message_contents" c
        ON c."acquisitionMessageId" = d."acquisitionMessageId"
       AND c."companyId" = d."companyId"
      WHERE ${NEED_DETECTION_SQL}
      GROUP BY d."companyId"
      ORDER BY d."companyId" ASC
      LIMIT ${limit}
    `
    return rows.map((r) => r.companyId)
  }

  async listCandidatesForCompany(input: {
    companyId: string
    limit: number
  }): Promise<ConsultationDetectionCandidate[]> {
    if (!input.companyId) return []
    const limit = Math.max(1, Math.floor(input.limit))
    const rows = await this.db.$queryRaw<CandidateRow[]>`
      SELECT
        d."id",
        d."companyId",
        d."acquisitionMessageId",
        d."version",
        d."createdAt",
        d."updatedAt"
      FROM "worksite_import_drafts" d
      INNER JOIN "acquisition_message_contents" c
        ON c."acquisitionMessageId" = d."acquisitionMessageId"
       AND c."companyId" = d."companyId"
      WHERE d."companyId" = ${input.companyId}
        AND ${NEED_DETECTION_SQL}
      ORDER BY d."updatedAt" ASC, d."id" ASC
      LIMIT ${limit}
    `
    return rows.map((d) => ({
      draftId: d.id,
      companyId: d.companyId,
      acquisitionMessageId: d.acquisitionMessageId,
      version: d.version,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }))
  }
}

export const acquisitionConsultationDetectionSelectionRepository =
  new AcquisitionConsultationDetectionSelectionRepository()
