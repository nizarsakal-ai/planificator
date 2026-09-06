/**
 * PLAN-ACQ-CONSULTATIONS-FIX-001 — Suivi d’annulation fail-closed.
 * threadId exact uniquement pour lier d’autres drafts (pas de fuzzy nom).
 * Jamais de mutation Worksite.
 *
 * PLAN-ACQ-AGENTS-LOT-3D/3E-CORRECTION-4B — API transactionnelle
 * `applyCancellationFollowUpTransactionally` (advisory xact lock + journal atomique).
 * Le legacy `applyCancellationFollowUp` reste non transactionnel (chemin XOR flags).
 */

import { createHash } from "node:crypto"
import {
  Prisma,
  type PrismaClient,
  type WorksiteImportDraftStatus,
} from "@prisma/client"
import {
  AcquisitionDecisionJournalRepository,
  buildCancellationFollowUpIdempotencyKey,
  type CancellationFollowUpJournalCode,
  type FrozenValidationCycle,
  type JournalRow,
} from "@/lib/acquisition/policy/decision-journal.repository"

const REJECTABLE: WorksiteImportDraftStatus[] = [
  "PENDING_EXTRACTION",
  "EXTRACTING",
  "PENDING_REVIEW",
  "APPROVED",
  "FAILED",
]

export type CancellationFollowUpResult = {
  linkedDraftIdsRejected: string[]
  convertedWorksiteIdsUntouched: string[]
  ambiguous: boolean
  journalCode:
    | "CANCELLATION_FOLLOWUP_APPLIED"
    | "CANCELLATION_AFTER_CONVERSION"
    | "CANCELLATION_TARGET_AMBIGUOUS"
    | "CANCELLATION_NO_LINK"
}

export type CancellationFollowUpTransactionalResult = CancellationFollowUpResult & {
  outcome: "APPENDED" | "ALREADY_EXISTS"
  journalRow: JournalRow | null
}

type LinkedDraftLite = {
  id: string
  status: WorksiteImportDraftStatus
  createdWorksiteId: string | null
  rejectionReason?: string | null
}

/**
 * Classification pure (sans mutation) — partagée legacy / 4B.
 * `journalCode: CANCELLATION_FOLLOWUP_APPLIED` + rejectTargetId = cible prête à rejeter
 * (pas encore prouvée) ; n’utiliser APPLIED journalisé qu’après count=1 ou adoption
 * CANCELLED_BY_FOLLOWUP.
 */
export function classifyCancellationFollowUpTargets(input: {
  sourceDraftId: string
  linkedDrafts: LinkedDraftLite[]
}): CancellationFollowUpResult & { rejectTargetId: string | null } {
  const others = input.linkedDrafts.filter((d) => d.id !== input.sourceDraftId)

  if (others.length === 0) {
    return {
      linkedDraftIdsRejected: [],
      convertedWorksiteIdsUntouched: [],
      ambiguous: false,
      journalCode: "CANCELLATION_NO_LINK",
      rejectTargetId: null,
    }
  }

  // CORRECTION-4B-R2 — CONVERTED sans worksite = état structurellement incohérent.
  const convertedWithoutWorksite = others.some(
    (d) =>
      d.status === "CONVERTED" &&
      (d.createdWorksiteId == null || d.createdWorksiteId.trim() === "")
  )
  if (convertedWithoutWorksite) {
    throw new Error("CANCELLATION_FOLLOWUP_STATE_INCONSISTENT")
  }

  const converted = others.filter(
    (d) => d.status === "CONVERTED" && d.createdWorksiteId
  )
  const pendingLike = others.filter((d) => REJECTABLE.includes(d.status))
  const convertedWorksiteIdsUntouched = converted
    .map((d) => d.createdWorksiteId)
    .filter((id): id is string => Boolean(id))

  if (converted.length > 0) {
    return {
      linkedDraftIdsRejected: [],
      convertedWorksiteIdsUntouched,
      ambiguous: pendingLike.length > 1,
      journalCode: "CANCELLATION_AFTER_CONVERSION",
      rejectTargetId: null,
    }
  }

  if (pendingLike.length > 1) {
    return {
      linkedDraftIdsRejected: [],
      convertedWorksiteIdsUntouched: [],
      ambiguous: true,
      journalCode: "CANCELLATION_TARGET_AMBIGUOUS",
      rejectTargetId: null,
    }
  }

  if (pendingLike.length === 1) {
    return {
      linkedDraftIdsRejected: [],
      convertedWorksiteIdsUntouched: [],
      ambiguous: false,
      journalCode: "CANCELLATION_FOLLOWUP_APPLIED",
      rejectTargetId: pendingLike[0]!.id,
    }
  }

  return {
    linkedDraftIdsRejected: [],
    convertedWorksiteIdsUntouched: [],
    ambiguous: false,
    journalCode: "CANCELLATION_NO_LINK",
    rejectTargetId: null,
  }
}

/**
 * CORRECTION-4B-R1 — après updateMany count=0 : classification depuis l’état frais.
 * Ne default jamais à NO_LINK sans relecture.
 */
export function reclassifyCancellationAfterUpdateMiss(input: {
  sourceDraftId: string
  intendedTargetId: string
  linkedDrafts: LinkedDraftLite[]
}): CancellationFollowUpResult {
  const intended = input.linkedDrafts.find((d) => d.id === input.intendedTargetId)
  if (
    intended &&
    intended.status === "REJECTED" &&
    intended.rejectionReason === "CANCELLED_BY_FOLLOWUP"
  ) {
    return {
      linkedDraftIdsRejected: [input.intendedTargetId],
      convertedWorksiteIdsUntouched: [],
      ambiguous: false,
      journalCode: "CANCELLATION_FOLLOWUP_APPLIED",
    }
  }

  const classified = classifyCancellationFollowUpTargets({
    sourceDraftId: input.sourceDraftId,
    linkedDrafts: input.linkedDrafts,
  })

  // Encore une cible rejectable alors que notre update a échoué → état non sûr.
  if (classified.rejectTargetId != null) {
    throw new Error("CANCELLATION_FOLLOWUP_STATE_INCONSISTENT")
  }

  const { rejectTargetId: _, ...rest } = classified
  return rest
}

async function loadThreadLinkedDrafts(
  tx: Prisma.TransactionClient | PrismaClient,
  input: { companyId: string; threadId: string }
): Promise<LinkedDraftLite[]> {
  const messages = await tx.acquisitionMessage.findMany({
    where: {
      companyId: input.companyId,
      threadId: input.threadId,
    },
    select: {
      id: true,
      draft: {
        select: {
          id: true,
          status: true,
          createdWorksiteId: true,
          rejectionReason: true,
        },
      },
    },
  })
  return messages
    .map((m) => m.draft)
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
}

/**
 * Legacy FIX-001 — mutation éventuelle SANS journal / SANS TX.
 * Conservé pour auto-decision.service.ts (chemin XOR feature flags).
 * CORRECTION-4B : le worker post-extraction utilise
 * `applyCancellationFollowUpTransactionally` à la place.
 */
export async function applyCancellationFollowUp(input: {
  companyId: string
  sourceDraftId: string
  threadId: string | null
  db: PrismaClient
}): Promise<CancellationFollowUpResult> {
  const empty: CancellationFollowUpResult = {
    linkedDraftIdsRejected: [],
    convertedWorksiteIdsUntouched: [],
    ambiguous: false,
    journalCode: "CANCELLATION_NO_LINK",
  }

  if (!input.threadId?.trim()) return empty

  const linked = await loadThreadLinkedDrafts(input.db, {
    companyId: input.companyId,
    threadId: input.threadId,
  })

  const classified = classifyCancellationFollowUpTargets({
    sourceDraftId: input.sourceDraftId,
    linkedDrafts: linked,
  })

  if (classified.rejectTargetId == null) {
    const { rejectTargetId: _, ...rest } = classified
    return rest
  }

  const upd = await input.db.worksiteImportDraft.updateMany({
    where: {
      id: classified.rejectTargetId,
      companyId: input.companyId,
      status: { in: REJECTABLE },
    },
    data: {
      status: "REJECTED",
      rejectionReason: "CANCELLED_BY_FOLLOWUP",
      version: { increment: 1 },
    },
  })
  if (upd.count === 1) {
    return {
      linkedDraftIdsRejected: [classified.rejectTargetId],
      convertedWorksiteIdsUntouched: [],
      ambiguous: false,
      journalCode: "CANCELLATION_FOLLOWUP_APPLIED",
    }
  }

  return empty
}

/** CORRECTION-4B — clés int4 pour pg_advisory_xact_lock (companyId + threadId). */
export function buildCancellationThreadAdvisoryLockKeys(input: {
  companyId: string
  threadId: string
}): { key1: number; key2: number } {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "acq-cancel-followup-lock-v1",
        input.companyId,
        input.threadId,
      ]),
      "utf8"
    )
    .digest()
  return {
    key1: digest.readInt32BE(0),
    key2: digest.readInt32BE(4),
  }
}

export async function acquireCancellationThreadAdvisoryXactLock(
  tx: Prisma.TransactionClient,
  companyId: string,
  threadId: string
): Promise<void> {
  const { key1, key2 } = buildCancellationThreadAdvisoryLockKeys({
    companyId,
    threadId,
  })
  // Prisma paramètre souvent en bigint ; l’overload 2-args exige int4.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock((${key1})::integer, (${key2})::integer)`
}

function followUpFromJournalRow(
  row: JournalRow & { decisionCode: CancellationFollowUpJournalCode }
): CancellationFollowUpResult {
  const meta =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {}
  const linked = Array.isArray(meta.linkedDraftIdsRejected)
    ? meta.linkedDraftIdsRejected.filter((x): x is string => typeof x === "string")
    : []
  const converted = Array.isArray(meta.convertedWorksiteIdsUntouched)
    ? meta.convertedWorksiteIdsUntouched.filter(
        (x): x is string => typeof x === "string"
      )
    : []
  return {
    linkedDraftIdsRejected: linked,
    convertedWorksiteIdsUntouched: converted,
    ambiguous: meta.ambiguous === true,
    journalCode: row.decisionCode,
  }
}

function journalMetadata(
  frozen: FrozenValidationCycle,
  follow: CancellationFollowUpResult
): Record<string, unknown> {
  return {
    pipeline: "POST_EXTRACTION_STEPS",
    validationCycle: {
      contentHash: frozen.contentHash,
      extractionSchemaVersion: frozen.extractionSchemaVersion,
      validatedDraftVersion: frozen.validatedDraftVersion,
    },
    linkedDraftIdsRejected: follow.linkedDraftIdsRejected,
    convertedWorksiteIdsUntouched: follow.convertedWorksiteIdsUntouched,
    ambiguous: follow.ambiguous,
  }
}

async function appendCancellationJournalOnce(input: {
  db: PrismaClient | Prisma.TransactionClient
  companyId: string
  sourceDraftId: string
  frozen: FrozenValidationCycle
  actorUserId: string | null
  reasons: string[]
  follow: CancellationFollowUpResult
}): Promise<CancellationFollowUpTransactionalResult> {
  const journal = new AcquisitionDecisionJournalRepository(input.db)
  const idempotencyKey = buildCancellationFollowUpIdempotencyKey({
    companyId: input.companyId,
    sourceDraftId: input.sourceDraftId,
    frozen: input.frozen,
  })
  const append = await journal.appendOnce({
    companyId: input.companyId,
    draftId: input.sourceDraftId,
    decisionCode: input.follow.journalCode,
    reasons: input.reasons,
    scores: {},
    actorUserId: input.actorUserId,
    idempotencyKey,
    metadata: journalMetadata(input.frozen, input.follow),
  })
  const code = append.row.decisionCode as CancellationFollowUpJournalCode
  const fromWinner =
    append.outcome === "ALREADY_EXISTS"
      ? followUpFromJournalRow({
          ...append.row,
          decisionCode: code,
        })
      : input.follow
  return {
    ...fromWinner,
    outcome: append.outcome,
    journalRow: append.row,
  }
}

/**
 * CORRECTION-4B — follow-up transactionnel :
 * advisory xact lock(companyId, threadId) → relecture → mutation → journal.
 * Mutation + journal CANCELLATION_* dans la même TX (sauf NO_LINK sans thread :
 * appendOnce atomique hors lock).
 */
export async function applyCancellationFollowUpTransactionally(input: {
  companyId: string
  sourceDraftId: string
  threadId: string | null
  frozen: FrozenValidationCycle
  actorUserId: string | null
  db: PrismaClient
  reasons?: string[]
}): Promise<CancellationFollowUpTransactionalResult> {
  const reasons = input.reasons ?? ["CONSULTATION_CANCELLED"]
  const threadId = input.threadId?.trim() || null

  if (!threadId) {
    return appendCancellationJournalOnce({
      db: input.db,
      companyId: input.companyId,
      sourceDraftId: input.sourceDraftId,
      frozen: input.frozen,
      actorUserId: input.actorUserId,
      reasons,
      follow: {
        linkedDraftIdsRejected: [],
        convertedWorksiteIdsUntouched: [],
        ambiguous: false,
        journalCode: "CANCELLATION_NO_LINK",
      },
    })
  }

  const journalRoot = new AcquisitionDecisionJournalRepository(input.db)

  try {
    return await input.db.$transaction(async (tx) => {
      await acquireCancellationThreadAdvisoryXactLock(
        tx,
        input.companyId,
        threadId
      )

      const existing = await new AcquisitionDecisionJournalRepository(
        tx
      ).findLatestCancellationFollowUpForCycle({
        companyId: input.companyId,
        draftId: input.sourceDraftId,
        frozen: input.frozen,
      })
      if (existing) {
        return {
          ...followUpFromJournalRow(existing),
          outcome: "ALREADY_EXISTS" as const,
          journalRow: existing,
        }
      }

      const linked = await loadThreadLinkedDrafts(tx, {
        companyId: input.companyId,
        threadId,
      })

      const classified = classifyCancellationFollowUpTargets({
        sourceDraftId: input.sourceDraftId,
        linkedDrafts: linked,
      })

      let follow: CancellationFollowUpResult
      if (classified.rejectTargetId == null) {
        const { rejectTargetId: _, ...rest } = classified
        follow = rest
      } else {
        const targetId = classified.rejectTargetId
        const upd = await tx.worksiteImportDraft.updateMany({
          where: {
            id: targetId,
            companyId: input.companyId,
            status: { in: REJECTABLE },
          },
          data: {
            status: "REJECTED",
            rejectionReason: "CANCELLED_BY_FOLLOWUP",
            version: { increment: 1 },
          },
        })
        if (upd.count === 1) {
          follow = {
            linkedDraftIdsRejected: [targetId],
            convertedWorksiteIdsUntouched: [],
            ambiguous: false,
            journalCode: "CANCELLATION_FOLLOWUP_APPLIED",
          }
        } else {
          // CORRECTION-4B-R1 — relecture fraîche sous le même lock / même TX.
          const fresh = await loadThreadLinkedDrafts(tx, {
            companyId: input.companyId,
            threadId,
          })
          follow = reclassifyCancellationAfterUpdateMiss({
            sourceDraftId: input.sourceDraftId,
            intendedTargetId: targetId,
            linkedDrafts: fresh,
          })
        }
      }

      // create strict dans la TX (pas de catch P2002 ici — TX abortée sinon).
      const idempotencyKey = buildCancellationFollowUpIdempotencyKey({
        companyId: input.companyId,
        sourceDraftId: input.sourceDraftId,
        frozen: input.frozen,
      })
      const row = await tx.acquisitionDecisionJournal.create({
        data: {
          companyId: input.companyId,
          draftId: input.sourceDraftId,
          decisionCode: follow.journalCode,
          reasons: reasons as Prisma.InputJsonValue,
          scores: {} as Prisma.InputJsonValue,
          actorUserId: input.actorUserId,
          metadata: journalMetadata(input.frozen, follow) as Prisma.InputJsonValue,
          idempotencyKey,
        },
        select: {
          id: true,
          companyId: true,
          draftId: true,
          decisionCode: true,
          reasons: true,
          scores: true,
          actorUserId: true,
          metadata: true,
          createdAt: true,
          idempotencyKey: true,
        },
      })

      return {
        ...follow,
        outcome: "APPENDED" as const,
        journalRow: row,
      }
    })
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await journalRoot.findLatestCancellationFollowUpForCycle({
        companyId: input.companyId,
        draftId: input.sourceDraftId,
        frozen: input.frozen,
      })
      if (existing) {
        return {
          ...followUpFromJournalRow(existing),
          outcome: "ALREADY_EXISTS",
          journalRow: existing,
        }
      }
    }
    throw error
  }
}
