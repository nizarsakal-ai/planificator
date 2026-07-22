/**
 * PLAN-ACQ-OPS-004-R1 — Sélection lecture seule des drafts éligibles.
 * Backoff / stale / content exprimés en PostgreSQL (pas d’overfetch + filtre mémoire).
 * Aucune mutation ; claim / attempts restent 005B.
 */

import type { PrismaClient, WorksiteImportDraftStatus } from "@prisma/client"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"

export interface ExtractionCronCandidate {
  draftId: string
  companyId: string
  acquisitionMessageId: string
  status: WorksiteImportDraftStatus
  createdAt: Date
  extractionAttemptCount: number
  lastExtractionErrorAt: Date | null
  extractionStartedAt: Date | null
}

export interface ExtractionCronSelectionRepository {
  listCompanyIdsWithEligibleExtraction(input: {
    limit: number
    now: Date
    maxAttempts: number
    reclaimTtlMs: number
  }): Promise<string[]>
  listEligibleCandidatesForCompany(input: {
    companyId: string
    limit: number
    now: Date
    maxAttempts: number
    reclaimTtlMs: number
  }): Promise<ExtractionCronCandidate[]>
}

type EligibleDraftRow = {
  id: string
  companyId: string
  acquisitionMessageId: string
  status: WorksiteImportDraftStatus
  createdAt: Date
  extractionAttemptCount: number
  lastExtractionErrorAt: Date | null
  extractionStartedAt: Date | null
}

/**
 * Intervalle de backoff SPEC-R1 sur alias `d` :
 * attemptCount <= 0 → 0 min ; sinon min(15, 2^(attemptCount - 1)).
 */
const BACKOFF_INTERVAL_SQL = Prisma.sql`
  (
    CASE
      WHEN d."extractionAttemptCount" <= 0 THEN INTERVAL '0 minutes'
      ELSE LEAST(15::double precision, POWER(2::double precision, d."extractionAttemptCount" - 1))
           * INTERVAL '1 minute'
    END
  )
`

function eligibleWhereSql(input: {
  now: Date
  maxAttempts: number
  reclaimBefore: Date
  companyId?: string
}): Prisma.Sql {
  const companyClause =
    input.companyId != null && input.companyId !== ""
      ? Prisma.sql`AND d."companyId" = ${input.companyId}`
      : Prisma.empty

  return Prisma.sql`
    d."extractionAttemptCount" < ${input.maxAttempts}
    ${companyClause}
    AND c."normalizedText" <> ''
    AND (
      d."status" = CAST('PENDING_EXTRACTION' AS "WorksiteImportDraftStatus")
      OR (
        d."status" = CAST('FAILED' AS "WorksiteImportDraftStatus")
        AND d."lastExtractionErrorAt" IS NOT NULL
        AND d."lastExtractionErrorAt" + ${BACKOFF_INTERVAL_SQL} <= ${input.now}
      )
      OR (
        d."status" = CAST('EXTRACTING' AS "WorksiteImportDraftStatus")
        AND d."extractionStartedAt" IS NOT NULL
        AND d."extractionStartedAt" < ${input.reclaimBefore}
      )
    )
  `
}

export class AcquisitionExtractionCronSelectionRepository
  implements ExtractionCronSelectionRepository
{
  constructor(private readonly db: PrismaClient = prisma) {}

  /**
   * Companies ayant au moins un candidat réellement éligible (backoff/stale en SQL).
   * Ordre déterministe companyId ASC — pas d’overfetch mémoire.
   */
  async listCompanyIdsWithEligibleExtraction(input: {
    limit: number
    now: Date
    maxAttempts: number
    reclaimTtlMs: number
  }): Promise<string[]> {
    const limit = Math.max(1, Math.floor(input.limit))
    const reclaimBefore = new Date(input.now.getTime() - input.reclaimTtlMs)

    const rows = await this.db.$queryRaw<Array<{ companyId: string }>>`
      SELECT d."companyId" AS "companyId"
      FROM "worksite_import_drafts" d
      INNER JOIN "acquisition_message_contents" c
        ON c."acquisitionMessageId" = d."acquisitionMessageId"
       AND c."companyId" = d."companyId"
      WHERE ${eligibleWhereSql({
        now: input.now,
        maxAttempts: input.maxAttempts,
        reclaimBefore,
      })}
      GROUP BY d."companyId"
      ORDER BY d."companyId" ASC
      LIMIT ${limit}
    `
    return rows.map((r) => r.companyId)
  }

  /**
   * Candidats réellement éligibles pour un tenant — LIMIT appliqué après prédicat SQL.
   * FIFO : createdAt ASC, id ASC.
   */
  async listEligibleCandidatesForCompany(input: {
    companyId: string
    limit: number
    now: Date
    maxAttempts: number
    reclaimTtlMs: number
  }): Promise<ExtractionCronCandidate[]> {
    if (!input.companyId) return []
    const limit = Math.max(1, Math.floor(input.limit))
    const reclaimBefore = new Date(input.now.getTime() - input.reclaimTtlMs)

    const drafts = await this.db.$queryRaw<EligibleDraftRow[]>`
      SELECT
        d."id",
        d."companyId",
        d."acquisitionMessageId",
        d."status",
        d."createdAt",
        d."extractionAttemptCount",
        d."lastExtractionErrorAt",
        d."extractionStartedAt"
      FROM "worksite_import_drafts" d
      INNER JOIN "acquisition_message_contents" c
        ON c."acquisitionMessageId" = d."acquisitionMessageId"
       AND c."companyId" = d."companyId"
      WHERE ${eligibleWhereSql({
        now: input.now,
        maxAttempts: input.maxAttempts,
        reclaimBefore,
        companyId: input.companyId,
      })}
      ORDER BY d."createdAt" ASC, d."id" ASC
      LIMIT ${limit}
    `

    return drafts.map((d) => ({
      draftId: d.id,
      companyId: d.companyId,
      acquisitionMessageId: d.acquisitionMessageId,
      status: d.status,
      createdAt: d.createdAt,
      extractionAttemptCount: d.extractionAttemptCount,
      lastExtractionErrorAt: d.lastExtractionErrorAt,
      extractionStartedAt: d.extractionStartedAt,
    }))
  }
}

export const acquisitionExtractionCronSelectionRepository =
  new AcquisitionExtractionCronSelectionRepository()
