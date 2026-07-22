import type { Prisma, PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { contentFetchBackoffMinutes } from "@/lib/acquisition/content/content-cron-feature-flag"

export interface ContentFetchCandidate {
  draftId: string
  acquisitionMessageId: string
  companyId: string
  draftCreatedAt: Date
}

export interface MarkFailureResult {
  terminal: boolean
  attemptCount: number
  /** true si aucune mutation car content déjà présent (course succès/échec). */
  skippedDueToContent?: boolean
}

/** Port orchestrateur — sélection + état poison/retry. */
export interface ContentFetchOrchestratorRepository {
  listCompanyIdsWithEligibleContentFetch(input: {
    limit: number
    now: Date
  }): Promise<string[]>
  listEligibleCandidatesForCompany(input: {
    companyId: string
    limit: number
    now: Date
  }): Promise<ContentFetchCandidate[]>
  hasContent(input: { companyId: string; acquisitionMessageId: string }): Promise<boolean>
  markRetryableFailure(input: {
    companyId: string
    acquisitionMessageId: string
    errorCode: string
    now: Date
    maxAttempts: number
  }): Promise<MarkFailureResult>
  markPermanentFailure(input: {
    companyId: string
    acquisitionMessageId: string
    errorCode: string
    now: Date
  }): Promise<MarkFailureResult>
}

function eligibleFetchStateFilter(now: Date) {
  return {
    OR: [
      { contentFetchState: { is: null } },
      {
        contentFetchState: {
          is: {
            terminalAt: null,
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
        },
      },
    ],
  }
}

type Tx = Prisma.TransactionClient

/**
 * Ensure row exists without aborting the TX on concurrent create.
 * id aléatoire + ON CONFLICT DO NOTHING (toute unicité : PK ou acquisitionMessageId)
 * — évite 23505 / 25P02 mid-transaction.
 */
async function ensureFetchStateRowSql(
  tx: Tx,
  input: { companyId: string; acquisitionMessageId: string; now: Date }
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "acquisition_content_fetch_states" (
      "id",
      "companyId",
      "acquisitionMessageId",
      "attemptCount",
      "lastErrorCode",
      "lastErrorAt",
      "nextRetryAt",
      "terminalAt",
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${crypto.randomUUID()},
      ${input.companyId},
      ${input.acquisitionMessageId},
      0,
      NULL,
      NULL,
      NULL,
      NULL,
      ${input.now},
      ${input.now}
    )
    ON CONFLICT DO NOTHING
  `
}

/**
 * Incrément atomique attemptCount + champs erreur.
 * RETURNING = nouvelle valeur. nextRetryAt/terminalAt posés juste après dans la même TX.
 */
async function atomicIncrementAttempt(
  tx: Tx,
  input: {
    companyId: string
    acquisitionMessageId: string
    errorCode: string
    now: Date
  }
): Promise<{ attemptCount: number } | null> {
  const rows = await tx.$queryRaw<Array<{ attemptCount: number }>>`
    UPDATE "acquisition_content_fetch_states"
    SET
      "attemptCount" = "attemptCount" + 1,
      "lastErrorCode" = ${input.errorCode},
      "lastErrorAt" = ${input.now},
      "updatedAt" = ${input.now}
    WHERE "companyId" = ${input.companyId}
      AND "acquisitionMessageId" = ${input.acquisitionMessageId}
    RETURNING "attemptCount"
  `
  return rows[0] ?? null
}

/**
 * Pose nextRetryAt / terminalAt sans jamais effacer un terminalAt déjà posé.
 * Filtre explicite companyId + acquisitionMessageId.
 */
async function applyRetryableScheduleSql(
  tx: Tx,
  input: {
    companyId: string
    acquisitionMessageId: string
    now: Date
    nextRetryAt: Date | null
    shouldTerminal: boolean
  }
): Promise<{ attemptCount: number; terminalAt: Date | null } | null> {
  const rows = await tx.$queryRaw<Array<{ attemptCount: number; terminalAt: Date | null }>>`
    UPDATE "acquisition_content_fetch_states"
    SET
      "nextRetryAt" = CASE
        WHEN "terminalAt" IS NOT NULL THEN NULL
        WHEN ${input.shouldTerminal} THEN NULL
        ELSE ${input.nextRetryAt}
      END,
      "terminalAt" = CASE
        WHEN "terminalAt" IS NOT NULL THEN "terminalAt"
        WHEN ${input.shouldTerminal} THEN ${input.now}
        ELSE NULL
      END,
      "updatedAt" = ${input.now}
    WHERE "companyId" = ${input.companyId}
      AND "acquisitionMessageId" = ${input.acquisitionMessageId}
    RETURNING "attemptCount", "terminalAt"
  `
  return rows[0] ?? null
}

async function applyPermanentScheduleSql(
  tx: Tx,
  input: {
    companyId: string
    acquisitionMessageId: string
    now: Date
  }
): Promise<{ attemptCount: number; terminalAt: Date | null } | null> {
  const rows = await tx.$queryRaw<Array<{ attemptCount: number; terminalAt: Date | null }>>`
    UPDATE "acquisition_content_fetch_states"
    SET
      "nextRetryAt" = NULL,
      "terminalAt" = COALESCE("terminalAt", ${input.now}),
      "updatedAt" = ${input.now}
    WHERE "companyId" = ${input.companyId}
      AND "acquisitionMessageId" = ${input.acquisitionMessageId}
    RETURNING "attemptCount", "terminalAt"
  `
  return rows[0] ?? null
}

export class AcquisitionContentFetchStateRepository implements ContentFetchOrchestratorRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  async listCompanyIdsWithEligibleContentFetch(input: {
    limit: number
    now: Date
  }): Promise<string[]> {
    const limit = Math.max(1, Math.floor(input.limit))
    const drafts = await this.db.worksiteImportDraft.findMany({
      where: {
        status: "PENDING_EXTRACTION",
        acquisitionMessage: {
          status: "DRAFT_CREATED",
          content: { is: null },
          ...eligibleFetchStateFilter(input.now),
        },
      },
      select: { companyId: true },
      distinct: ["companyId"],
      orderBy: { companyId: "asc" },
      take: limit,
    })
    return drafts.map((d) => d.companyId)
  }

  async listEligibleCandidatesForCompany(input: {
    companyId: string
    limit: number
    now: Date
  }): Promise<ContentFetchCandidate[]> {
    if (!input.companyId) return []
    const limit = Math.max(1, Math.floor(input.limit))
    const drafts = await this.db.worksiteImportDraft.findMany({
      where: {
        companyId: input.companyId,
        status: "PENDING_EXTRACTION",
        acquisitionMessage: {
          status: "DRAFT_CREATED",
          content: { is: null },
          ...eligibleFetchStateFilter(input.now),
        },
      },
      select: {
        id: true,
        acquisitionMessageId: true,
        companyId: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
    })
    return drafts.map((d) => ({
      draftId: d.id,
      acquisitionMessageId: d.acquisitionMessageId,
      companyId: d.companyId,
      draftCreatedAt: d.createdAt,
    }))
  }

  async hasContent(input: {
    companyId: string
    acquisitionMessageId: string
  }): Promise<boolean> {
    if (!input.companyId || !input.acquisitionMessageId) return false
    const row = await this.db.acquisitionMessageContent.findFirst({
      where: {
        companyId: input.companyId,
        acquisitionMessageId: input.acquisitionMessageId,
      },
      select: { id: true },
    })
    return Boolean(row)
  }

  /**
   * Retryable : INSERT ON CONFLICT DO NOTHING + UPDATE attemptCount+1 atomique + schedule.
   * TX courte — aucun fetch Gmail. Ne clear jamais un terminalAt existant.
   */
  async markRetryableFailure(input: {
    companyId: string
    acquisitionMessageId: string
    errorCode: string
    now: Date
    maxAttempts: number
  }): Promise<MarkFailureResult> {
    if (await this.hasContent(input)) {
      return { terminal: false, attemptCount: 0, skippedDueToContent: true }
    }

    return this.db.$transaction(async (tx) => {
      const content = await tx.acquisitionMessageContent.findFirst({
        where: {
          companyId: input.companyId,
          acquisitionMessageId: input.acquisitionMessageId,
        },
        select: { id: true },
      })
      if (content) {
        return { terminal: false, attemptCount: 0, skippedDueToContent: true }
      }

      await ensureFetchStateRowSql(tx, {
        companyId: input.companyId,
        acquisitionMessageId: input.acquisitionMessageId,
        now: input.now,
      })

      const incremented = await atomicIncrementAttempt(tx, input)
      if (!incremented) {
        throw new Error("CONTENT_FETCH_STATE_INCREMENT_FAILED")
      }

      const attemptCount = incremented.attemptCount
      const shouldTerminal = attemptCount >= input.maxAttempts
      const nextRetryAt = shouldTerminal
        ? null
        : new Date(input.now.getTime() + contentFetchBackoffMinutes(attemptCount) * 60_000)

      const scheduled = await applyRetryableScheduleSql(tx, {
        companyId: input.companyId,
        acquisitionMessageId: input.acquisitionMessageId,
        now: input.now,
        nextRetryAt,
        shouldTerminal,
      })
      if (!scheduled) {
        throw new Error("CONTENT_FETCH_STATE_SCHEDULE_FAILED")
      }

      return {
        terminal: scheduled.terminalAt != null,
        attemptCount: scheduled.attemptCount,
      }
    })
  }

  /**
   * Permanente : INSERT ON CONFLICT DO NOTHING + incrément atomique + terminalAt (COALESCE).
   */
  async markPermanentFailure(input: {
    companyId: string
    acquisitionMessageId: string
    errorCode: string
    now: Date
  }): Promise<MarkFailureResult> {
    if (await this.hasContent(input)) {
      return { terminal: false, attemptCount: 0, skippedDueToContent: true }
    }

    return this.db.$transaction(async (tx) => {
      const content = await tx.acquisitionMessageContent.findFirst({
        where: {
          companyId: input.companyId,
          acquisitionMessageId: input.acquisitionMessageId,
        },
        select: { id: true },
      })
      if (content) {
        return { terminal: false, attemptCount: 0, skippedDueToContent: true }
      }

      await ensureFetchStateRowSql(tx, {
        companyId: input.companyId,
        acquisitionMessageId: input.acquisitionMessageId,
        now: input.now,
      })

      const incremented = await atomicIncrementAttempt(tx, input)
      if (!incremented) {
        throw new Error("CONTENT_FETCH_STATE_INCREMENT_FAILED")
      }

      const scheduled = await applyPermanentScheduleSql(tx, {
        companyId: input.companyId,
        acquisitionMessageId: input.acquisitionMessageId,
        now: input.now,
      })
      if (!scheduled) {
        throw new Error("CONTENT_FETCH_STATE_SCHEDULE_FAILED")
      }

      return { terminal: true, attemptCount: scheduled.attemptCount }
    })
  }
}

export const acquisitionContentFetchStateRepository = new AcquisitionContentFetchStateRepository()
