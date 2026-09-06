/**
 * PLAN-ACQ-AGENTS-LOT-3D/3E-CORRECTION-4B — follow-up cancellation transactionnel.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import {
  applyCancellationFollowUpTransactionally,
  buildCancellationThreadAdvisoryLockKeys,
  classifyCancellationFollowUpTargets,
  reclassifyCancellationAfterUpdateMiss,
} from "@/lib/acquisition/policy/cancellation-followup"
import {
  buildCancellationFollowUpIdempotencyKey,
  CANCELLATION_FOLLOWUP_CODES,
  type FrozenValidationCycle,
} from "@/lib/acquisition/policy/decision-journal.repository"

const WORKER_SRC = path.join(
  process.cwd(),
  "src/lib/acquisition/orchestrator/acquisition-auto-decision.worker.ts"
)

const frozen: FrozenValidationCycle = {
  contentHash: "h1",
  extractionSchemaVersion: "2",
  validatedDraftVersion: 7,
}

describe("CORRECTION-4B — advisory lock keys", () => {
  it("1 — lock key deterministic", () => {
    const a = buildCancellationThreadAdvisoryLockKeys({
      companyId: "co1",
      threadId: "th-1",
    })
    const b = buildCancellationThreadAdvisoryLockKeys({
      companyId: "co1",
      threadId: "th-1",
    })
    assert.deepEqual(a, b)
    assert.equal(typeof a.key1, "number")
    assert.equal(typeof a.key2, "number")
  })

  it("2 — companyId différent → lock key différente", () => {
    const a = buildCancellationThreadAdvisoryLockKeys({
      companyId: "co1",
      threadId: "th-1",
    })
    const b = buildCancellationThreadAdvisoryLockKeys({
      companyId: "co2",
      threadId: "th-1",
    })
    assert.notDeepEqual(a, b)
  })

  it("3 — threadId différent → lock key différente", () => {
    const a = buildCancellationThreadAdvisoryLockKeys({
      companyId: "co1",
      threadId: "th-1",
    })
    const b = buildCancellationThreadAdvisoryLockKeys({
      companyId: "co1",
      threadId: "th-2",
    })
    assert.notDeepEqual(a, b)
  })
})

describe("CORRECTION-4B — cancellation idempotency key", () => {
  it("4 — déterministe", () => {
    const a = buildCancellationFollowUpIdempotencyKey({
      companyId: "co1",
      sourceDraftId: "d1",
      frozen,
    })
    const b = buildCancellationFollowUpIdempotencyKey({
      companyId: "co1",
      sourceDraftId: "d1",
      frozen,
    })
    assert.equal(a, b)
    assert.match(a, /^v1:cancellation-followup:[a-f0-9]{64}$/)
  })

  it("5 — quatre journalCode → même slot", () => {
    const key = buildCancellationFollowUpIdempotencyKey({
      companyId: "co1",
      sourceDraftId: "d1",
      frozen,
    })
    for (const _code of CANCELLATION_FOLLOWUP_CODES) {
      assert.equal(
        buildCancellationFollowUpIdempotencyKey({
          companyId: "co1",
          sourceDraftId: "d1",
          frozen,
        }),
        key
      )
    }
  })

  it("6 — frozen cycle différent → clé différente", () => {
    const a = buildCancellationFollowUpIdempotencyKey({
      companyId: "co1",
      sourceDraftId: "d1",
      frozen,
    })
    const b = buildCancellationFollowUpIdempotencyKey({
      companyId: "co1",
      sourceDraftId: "d1",
      frozen: { ...frozen, validatedDraftVersion: 8 },
    })
    assert.notEqual(a, b)
  })
})

describe("CORRECTION-4B — classification pure", () => {
  it("9 — converted → AFTER_CONVERSION", () => {
    const r = classifyCancellationFollowUpTargets({
      sourceDraftId: "src",
      linkedDrafts: [
        { id: "src", status: "REJECTED", createdWorksiteId: null },
        {
          id: "done",
          status: "CONVERTED",
          createdWorksiteId: "ws1",
        },
      ],
    })
    assert.equal(r.journalCode, "CANCELLATION_AFTER_CONVERSION")
    assert.equal(r.rejectTargetId, null)
  })

  it("R2 — CONVERTED + createdWorksiteId null → fail-closed", () => {
    assert.throws(
      () =>
        classifyCancellationFollowUpTargets({
          sourceDraftId: "src",
          linkedDrafts: [
            { id: "src", status: "REJECTED", createdWorksiteId: null },
            {
              id: "done",
              status: "CONVERTED",
              createdWorksiteId: null,
            },
          ],
        }),
      (e: unknown) =>
        e instanceof Error &&
        e.message === "CANCELLATION_FOLLOWUP_STATE_INCONSISTENT"
    )
  })

  it("10 — plusieurs pending → TARGET_AMBIGUOUS", () => {
    const r = classifyCancellationFollowUpTargets({
      sourceDraftId: "src",
      linkedDrafts: [
        { id: "src", status: "REJECTED", createdWorksiteId: null },
        { id: "a", status: "PENDING_REVIEW", createdWorksiteId: null },
        { id: "b", status: "APPROVED", createdWorksiteId: null },
      ],
    })
    assert.equal(r.journalCode, "CANCELLATION_TARGET_AMBIGUOUS")
    assert.equal(r.rejectTargetId, null)
  })

  it("11 — aucun lien → NO_LINK", () => {
    const r = classifyCancellationFollowUpTargets({
      sourceDraftId: "src",
      linkedDrafts: [{ id: "src", status: "REJECTED", createdWorksiteId: null }],
    })
    assert.equal(r.journalCode, "CANCELLATION_NO_LINK")
  })
})

describe("CORRECTION-4B-R1 — reclassify après update miss", () => {
  it("R1.1 — count=0 + CONVERTED → AFTER_CONVERSION, jamais NO_LINK", () => {
    const r = reclassifyCancellationAfterUpdateMiss({
      sourceDraftId: "src",
      intendedTargetId: "tgt",
      linkedDrafts: [
        { id: "src", status: "REJECTED", createdWorksiteId: null },
        {
          id: "tgt",
          status: "CONVERTED",
          createdWorksiteId: "ws1",
          rejectionReason: null,
        },
      ],
    })
    assert.equal(r.journalCode, "CANCELLATION_AFTER_CONVERSION")
    assert.notEqual(r.journalCode, "CANCELLATION_NO_LINK")
    assert.deepEqual(r.convertedWorksiteIdsUntouched, ["ws1"])
  })

  it("R2 — count=0 + CONVERTED sans worksite → fail-closed", () => {
    assert.throws(
      () =>
        reclassifyCancellationAfterUpdateMiss({
          sourceDraftId: "src",
          intendedTargetId: "tgt",
          linkedDrafts: [
            { id: "src", status: "REJECTED", createdWorksiteId: null },
            {
              id: "tgt",
              status: "CONVERTED",
              createdWorksiteId: null,
              rejectionReason: null,
            },
          ],
        }),
      (e: unknown) =>
        e instanceof Error &&
        e.message === "CANCELLATION_FOLLOWUP_STATE_INCONSISTENT"
    )
  })

  it("R1.2 — count=0 + plusieurs rejectable → TARGET_AMBIGUOUS", () => {
    const r = reclassifyCancellationAfterUpdateMiss({
      sourceDraftId: "src",
      intendedTargetId: "tgt",
      linkedDrafts: [
        { id: "src", status: "REJECTED", createdWorksiteId: null },
        {
          id: "tgt",
          status: "REJECTED",
          createdWorksiteId: null,
          rejectionReason: "OTHER",
        },
        { id: "a", status: "PENDING_REVIEW", createdWorksiteId: null },
        { id: "b", status: "APPROVED", createdWorksiteId: null },
      ],
    })
    assert.equal(r.journalCode, "CANCELLATION_TARGET_AMBIGUOUS")
  })

  it("R1.3 — count=0 + aucun lien → NO_LINK", () => {
    const r = reclassifyCancellationAfterUpdateMiss({
      sourceDraftId: "src",
      intendedTargetId: "tgt",
      linkedDrafts: [
        { id: "src", status: "REJECTED", createdWorksiteId: null },
        {
          id: "tgt",
          status: "REJECTED",
          createdWorksiteId: null,
          rejectionReason: "HUMAN",
        },
      ],
    })
    assert.equal(r.journalCode, "CANCELLATION_NO_LINK")
  })

  it("R1.4 — count=0 + CANCELLED_BY_FOLLOWUP → APPLIED sans 2e mutation", () => {
    const r = reclassifyCancellationAfterUpdateMiss({
      sourceDraftId: "src",
      intendedTargetId: "tgt",
      linkedDrafts: [
        { id: "src", status: "REJECTED", createdWorksiteId: null },
        {
          id: "tgt",
          status: "REJECTED",
          createdWorksiteId: null,
          rejectionReason: "CANCELLED_BY_FOLLOWUP",
        },
      ],
    })
    assert.equal(r.journalCode, "CANCELLATION_FOLLOWUP_APPLIED")
    assert.deepEqual(r.linkedDraftIdsRejected, ["tgt"])
  })

  it("R1.5 — count=0 + état inattendu (encore rejectable) → fail-closed", () => {
    assert.throws(
      () =>
        reclassifyCancellationAfterUpdateMiss({
          sourceDraftId: "src",
          intendedTargetId: "tgt",
          linkedDrafts: [
            { id: "src", status: "REJECTED", createdWorksiteId: null },
            {
              id: "tgt",
              status: "PENDING_REVIEW",
              createdWorksiteId: null,
              rejectionReason: null,
            },
          ],
        }),
      (e: unknown) =>
        e instanceof Error &&
        e.message === "CANCELLATION_FOLLOWUP_STATE_INCONSISTENT"
    )
  })
})

type DraftRow = {
  id: string
  companyId: string
  status: string
  version: number
  rejectionReason: string | null
  createdWorksiteId: string | null
}

type JournalStoreRow = {
  id: string
  companyId: string
  draftId: string
  decisionCode: string
  reasons: unknown
  scores: unknown
  actorUserId: string | null
  metadata: unknown
  createdAt: Date
  idempotencyKey: string | null
}

function makeTransactionalFake(opts: {
  companyId: string
  threadId: string
  drafts: DraftRow[]
  messages: { id: string; companyId: string; threadId: string; draftId: string }[]
  journals?: JournalStoreRow[]
}) {
  const journals = opts.journals ?? []
  let journalSeq = 0
  let locks = 0
  let committed = true

  function snapshot() {
    return {
      drafts: opts.drafts.map((d) => ({ ...d })),
      journals: journals.map((j) => ({ ...j })),
    }
  }

  function buildTx(snap: ReturnType<typeof snapshot>) {
    return {
      async $executeRaw() {
        locks++
      },
      acquisitionMessage: {
        findMany: async (args: {
          where: { companyId: string; threadId: string }
        }) => {
          assert.equal(args.where.companyId, opts.companyId)
          return opts.messages
            .filter(
              (m) =>
                m.companyId === args.where.companyId &&
                m.threadId === args.where.threadId
            )
            .map((m) => ({
              id: m.id,
              draft: snap.drafts.find((d) => d.id === m.draftId) ?? null,
            }))
        },
      },
      worksiteImportDraft: {
        updateMany: async (args: {
          where: { id: string; companyId: string; status: { in: string[] } }
          data: {
            status: string
            rejectionReason: string
            version: { increment: number }
          }
        }) => {
          const d = snap.drafts.find(
            (x) =>
              x.id === args.where.id &&
              x.companyId === args.where.companyId &&
              args.where.status.in.includes(x.status)
          )
          if (!d) return { count: 0 }
          d.status = args.data.status
          d.rejectionReason = args.data.rejectionReason
          d.version += args.data.version.increment
          return { count: 1 }
        },
      },
      acquisitionDecisionJournal: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const key = String(data.idempotencyKey ?? "")
          if (snap.journals.some((j) => j.idempotencyKey === key)) {
            const { Prisma } = await import("@prisma/client")
            throw new Prisma.PrismaClientKnownRequestError("unique", {
              code: "P2002",
              clientVersion: "test",
            })
          }
          const row: JournalStoreRow = {
            id: `j${++journalSeq}`,
            companyId: String(data.companyId),
            draftId: String(data.draftId),
            decisionCode: String(data.decisionCode),
            reasons: data.reasons,
            scores: data.scores,
            actorUserId: (data.actorUserId as string | null) ?? null,
            metadata: data.metadata ?? null,
            createdAt: new Date(),
            idempotencyKey: key || null,
          }
          snap.journals.push(row)
          return row
        },
        findMany: async (args: {
          where: { companyId: string; draftId: string; decisionCode: { in: string[] } }
        }) => {
          return snap.journals
            .filter(
              (j) =>
                j.companyId === args.where.companyId &&
                j.draftId === args.where.draftId &&
                args.where.decisionCode.in.includes(j.decisionCode)
            )
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        },
        findUnique: async ({
          where,
        }: {
          where: { idempotencyKey: string }
        }) =>
          snap.journals.find((j) => j.idempotencyKey === where.idempotencyKey) ??
          null,
      },
    }
  }

  const db = {
    async $transaction<T>(fn: (tx: ReturnType<typeof buildTx>) => Promise<T>) {
      const snap = snapshot()
      try {
        const result = await fn(buildTx(snap))
        // commit
        for (let i = 0; i < opts.drafts.length; i++) {
          Object.assign(opts.drafts[i]!, snap.drafts[i]!)
        }
        journals.length = 0
        journals.push(...snap.journals)
        committed = true
        return result
      } catch (e) {
        committed = false
        throw e
      }
    },
    acquisitionDecisionJournal: {
      findMany: async (args: {
        where: { companyId: string; draftId: string; decisionCode: { in: string[] } }
      }) =>
        journals
          .filter(
            (j) =>
              j.companyId === args.where.companyId &&
              j.draftId === args.where.draftId &&
              args.where.decisionCode.in.includes(j.decisionCode)
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      findUnique: async ({
        where,
      }: {
        where: { idempotencyKey: string }
      }) => journals.find((j) => j.idempotencyKey === where.idempotencyKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const key = String(data.idempotencyKey ?? "")
        if (journals.some((j) => j.idempotencyKey === key)) {
          const { Prisma } = await import("@prisma/client")
          throw new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          })
        }
        const row: JournalStoreRow = {
          id: `j${++journalSeq}`,
          companyId: String(data.companyId),
          draftId: String(data.draftId),
          decisionCode: String(data.decisionCode),
          reasons: data.reasons,
          scores: data.scores,
          actorUserId: (data.actorUserId as string | null) ?? null,
          metadata: data.metadata ?? null,
          createdAt: new Date(),
          idempotencyKey: key || null,
        }
        journals.push(row)
        return row
      },
    },
  }

  return { db, journals, locks: () => locks, wasCommitted: () => committed }
}

describe("CORRECTION-4B — applyCancellationFollowUpTransactionally", () => {
  it("7 — journal préexistant → zéro mutation", async () => {
    const drafts: DraftRow[] = [
      {
        id: "src",
        companyId: "co1",
        status: "REJECTED",
        version: 2,
        rejectionReason: "CANCELLED_INITIAL",
        createdWorksiteId: null,
      },
      {
        id: "tgt",
        companyId: "co1",
        status: "PENDING_REVIEW",
        version: 1,
        rejectionReason: null,
        createdWorksiteId: null,
      },
    ]
    const key = buildCancellationFollowUpIdempotencyKey({
      companyId: "co1",
      sourceDraftId: "src",
      frozen,
    })
    const { db, journals } = makeTransactionalFake({
      companyId: "co1",
      threadId: "th-1",
      drafts,
      messages: [
        { id: "m1", companyId: "co1", threadId: "th-1", draftId: "src" },
        { id: "m2", companyId: "co1", threadId: "th-1", draftId: "tgt" },
      ],
      journals: [
        {
          id: "pre",
          companyId: "co1",
          draftId: "src",
          decisionCode: "CANCELLATION_FOLLOWUP_APPLIED",
          reasons: ["CONSULTATION_CANCELLED"],
          scores: {},
          actorUserId: null,
          metadata: {
            pipeline: "POST_EXTRACTION_STEPS",
            validationCycle: {
              contentHash: "h1",
              extractionSchemaVersion: "2",
              validatedDraftVersion: 7,
            },
            linkedDraftIdsRejected: ["tgt"],
            convertedWorksiteIdsUntouched: [],
            ambiguous: false,
          },
          createdAt: new Date(),
          idempotencyKey: key,
        },
      ],
    })

    const r = await applyCancellationFollowUpTransactionally({
      companyId: "co1",
      sourceDraftId: "src",
      threadId: "th-1",
      frozen,
      actorUserId: "sys",
      db: db as never,
    })
    assert.equal(r.outcome, "ALREADY_EXISTS")
    assert.equal(r.journalCode, "CANCELLATION_FOLLOWUP_APPLIED")
    assert.equal(drafts[1]!.status, "PENDING_REVIEW")
    assert.equal(drafts[1]!.version, 1)
    assert.equal(journals.length, 1)
  })

  it("8 — exactement une cible → reject + FOLLOWUP_APPLIED", async () => {
    const drafts: DraftRow[] = [
      {
        id: "src",
        companyId: "co1",
        status: "REJECTED",
        version: 2,
        rejectionReason: "CANCELLED_INITIAL",
        createdWorksiteId: null,
      },
      {
        id: "tgt",
        companyId: "co1",
        status: "PENDING_REVIEW",
        version: 1,
        rejectionReason: null,
        createdWorksiteId: null,
      },
    ]
    const { db, journals } = makeTransactionalFake({
      companyId: "co1",
      threadId: "th-1",
      drafts,
      messages: [
        { id: "m1", companyId: "co1", threadId: "th-1", draftId: "src" },
        { id: "m2", companyId: "co1", threadId: "th-1", draftId: "tgt" },
      ],
    })

    const r = await applyCancellationFollowUpTransactionally({
      companyId: "co1",
      sourceDraftId: "src",
      threadId: "th-1",
      frozen,
      actorUserId: "sys",
      db: db as never,
    })
    assert.equal(r.journalCode, "CANCELLATION_FOLLOWUP_APPLIED")
    assert.equal(r.outcome, "APPENDED")
    assert.deepEqual(r.linkedDraftIdsRejected, ["tgt"])
    assert.equal(drafts[1]!.status, "REJECTED")
    assert.equal(drafts[1]!.rejectionReason, "CANCELLED_BY_FOLLOWUP")
    assert.equal(drafts[1]!.version, 2)
    assert.equal(journals.length, 1)
    assert.equal(journals[0]!.decisionCode, "CANCELLATION_FOLLOWUP_APPLIED")
  })

  it("9b — converted présent → aucune mutation + AFTER_CONVERSION", async () => {
    const drafts: DraftRow[] = [
      {
        id: "src",
        companyId: "co1",
        status: "REJECTED",
        version: 2,
        rejectionReason: "X",
        createdWorksiteId: null,
      },
      {
        id: "done",
        companyId: "co1",
        status: "CONVERTED",
        version: 3,
        rejectionReason: null,
        createdWorksiteId: "ws1",
      },
    ]
    const { db } = makeTransactionalFake({
      companyId: "co1",
      threadId: "th-1",
      drafts,
      messages: [
        { id: "m1", companyId: "co1", threadId: "th-1", draftId: "src" },
        { id: "m2", companyId: "co1", threadId: "th-1", draftId: "done" },
      ],
    })
    const r = await applyCancellationFollowUpTransactionally({
      companyId: "co1",
      sourceDraftId: "src",
      threadId: "th-1",
      frozen,
      actorUserId: null,
      db: db as never,
    })
    assert.equal(r.journalCode, "CANCELLATION_AFTER_CONVERSION")
    assert.deepEqual(r.convertedWorksiteIdsUntouched, ["ws1"])
    assert.equal(drafts[1]!.status, "CONVERTED")
  })

  it("10b — plusieurs pending → TARGET_AMBIGUOUS", async () => {
    const drafts: DraftRow[] = [
      {
        id: "src",
        companyId: "co1",
        status: "REJECTED",
        version: 2,
        rejectionReason: "X",
        createdWorksiteId: null,
      },
      {
        id: "a",
        companyId: "co1",
        status: "PENDING_REVIEW",
        version: 1,
        rejectionReason: null,
        createdWorksiteId: null,
      },
      {
        id: "b",
        companyId: "co1",
        status: "APPROVED",
        version: 1,
        rejectionReason: null,
        createdWorksiteId: null,
      },
    ]
    const { db } = makeTransactionalFake({
      companyId: "co1",
      threadId: "th-1",
      drafts,
      messages: [
        { id: "m0", companyId: "co1", threadId: "th-1", draftId: "src" },
        { id: "m1", companyId: "co1", threadId: "th-1", draftId: "a" },
        { id: "m2", companyId: "co1", threadId: "th-1", draftId: "b" },
      ],
    })
    const r = await applyCancellationFollowUpTransactionally({
      companyId: "co1",
      sourceDraftId: "src",
      threadId: "th-1",
      frozen,
      actorUserId: null,
      db: db as never,
    })
    assert.equal(r.journalCode, "CANCELLATION_TARGET_AMBIGUOUS")
    assert.equal(drafts[1]!.status, "PENDING_REVIEW")
    assert.equal(drafts[2]!.status, "APPROVED")
  })

  it("11b — thread vide → NO_LINK journalisé", async () => {
    const drafts: DraftRow[] = [
      {
        id: "src",
        companyId: "co1",
        status: "REJECTED",
        version: 2,
        rejectionReason: "X",
        createdWorksiteId: null,
      },
    ]
    const { db, journals } = makeTransactionalFake({
      companyId: "co1",
      threadId: "th-unused",
      drafts,
      messages: [],
    })
    const r = await applyCancellationFollowUpTransactionally({
      companyId: "co1",
      sourceDraftId: "src",
      threadId: null,
      frozen,
      actorUserId: null,
      db: db as never,
    })
    assert.equal(r.journalCode, "CANCELLATION_NO_LINK")
    assert.equal(r.outcome, "APPENDED")
    assert.equal(journals.length, 1)
  })

  it("12 — update count=0 → reclassification fraîche (CONVERTED), jamais NO_LINK défaut", async () => {
    const drafts: DraftRow[] = [
      {
        id: "src",
        companyId: "co1",
        status: "REJECTED",
        version: 2,
        rejectionReason: "X",
        createdWorksiteId: null,
      },
      {
        id: "tgt",
        companyId: "co1",
        status: "PENDING_REVIEW",
        version: 1,
        rejectionReason: null,
        createdWorksiteId: null,
      },
    ]
    const { db, journals } = makeTransactionalFake({
      companyId: "co1",
      threadId: "th-1",
      drafts,
      messages: [
        { id: "m1", companyId: "co1", threadId: "th-1", draftId: "src" },
        { id: "m2", companyId: "co1", threadId: "th-1", draftId: "tgt" },
      ],
    })
    const origTx = db.$transaction.bind(db)
    db.$transaction = async (fn: (tx: never) => Promise<unknown>) =>
      origTx(async (tx) => {
        const t = tx as {
          worksiteImportDraft: {
            updateMany: (args: unknown) => Promise<{ count: number }>
          }
        }
        t.worksiteImportDraft.updateMany = async () => {
          const tgt = drafts.find((d) => d.id === "tgt")!
          // Simule course hors TX : état frais visible à la relecture via opts.drafts
          // (le fake lit snap — muter snap via retour au snapshot live).
          tgt.status = "CONVERTED"
          tgt.createdWorksiteId = "ws1"
          // Muter aussi dans le snap du tx courant : relecture findMany sur snap
          const snapDrafts = (
            tx as unknown as { __snapDrafts?: DraftRow[] }
          ).__snapDrafts
          void snapDrafts
          return { count: 0 }
        }
        // Patch findMany path: makeTransactionalFake uses snap — force live opts.drafts
        const am = (tx as { acquisitionMessage: { findMany: Function } })
          .acquisitionMessage
        const origFind = am.findMany.bind(am)
        am.findMany = async (args: unknown) => {
          const rows = await origFind(args)
          return rows.map((row: { id: string; draft: DraftRow | null }) => ({
            id: row.id,
            draft:
              row.draft == null
                ? null
                : drafts.find((d) => d.id === row.draft!.id) ?? row.draft,
          }))
        }
        return fn(tx as never)
      }) as typeof db.$transaction

    const r = await applyCancellationFollowUpTransactionally({
      companyId: "co1",
      sourceDraftId: "src",
      threadId: "th-1",
      frozen,
      actorUserId: null,
      db: db as never,
    })
    assert.equal(r.journalCode, "CANCELLATION_AFTER_CONVERSION")
    assert.notEqual(r.journalCode, "CANCELLATION_NO_LINK")
    assert.equal(journals[0]!.decisionCode, "CANCELLATION_AFTER_CONVERSION")
  })

  it("12b — count=0 + CANCELLED_BY_FOLLOWUP → APPLIED, zéro 2e mutation", async () => {
    const drafts: DraftRow[] = [
      {
        id: "src",
        companyId: "co1",
        status: "REJECTED",
        version: 2,
        rejectionReason: "X",
        createdWorksiteId: null,
      },
      {
        id: "tgt",
        companyId: "co1",
        status: "PENDING_REVIEW",
        version: 1,
        rejectionReason: null,
        createdWorksiteId: null,
      },
    ]
    let updateCalls = 0
    const { db } = makeTransactionalFake({
      companyId: "co1",
      threadId: "th-1",
      drafts,
      messages: [
        { id: "m1", companyId: "co1", threadId: "th-1", draftId: "src" },
        { id: "m2", companyId: "co1", threadId: "th-1", draftId: "tgt" },
      ],
    })
    const origTx = db.$transaction.bind(db)
    db.$transaction = async (fn: (tx: never) => Promise<unknown>) =>
      origTx(async (tx) => {
        const t = tx as {
          worksiteImportDraft: {
            updateMany: (args: unknown) => Promise<{ count: number }>
          }
          acquisitionMessage: { findMany: Function }
        }
        t.worksiteImportDraft.updateMany = async () => {
          updateCalls++
          drafts[1]!.status = "REJECTED"
          drafts[1]!.rejectionReason = "CANCELLED_BY_FOLLOWUP"
          drafts[1]!.version = 2
          return { count: 0 }
        }
        const origFind = t.acquisitionMessage.findMany.bind(t.acquisitionMessage)
        t.acquisitionMessage.findMany = async (args: unknown) => {
          const rows = await origFind(args)
          return rows.map((row: { id: string; draft: DraftRow | null }) => ({
            id: row.id,
            draft:
              row.draft == null
                ? null
                : drafts.find((d) => d.id === row.draft!.id) ?? row.draft,
          }))
        }
        return fn(tx as never)
      }) as typeof db.$transaction

    const r = await applyCancellationFollowUpTransactionally({
      companyId: "co1",
      sourceDraftId: "src",
      threadId: "th-1",
      frozen,
      actorUserId: null,
      db: db as never,
    })
    assert.equal(updateCalls, 1)
    assert.equal(r.journalCode, "CANCELLATION_FOLLOWUP_APPLIED")
    assert.deepEqual(r.linkedDraftIdsRejected, ["tgt"])
  })

  it("12c — count=0 + état inattendu → throw, aucun journal", async () => {
    const drafts: DraftRow[] = [
      {
        id: "src",
        companyId: "co1",
        status: "REJECTED",
        version: 2,
        rejectionReason: "X",
        createdWorksiteId: null,
      },
      {
        id: "tgt",
        companyId: "co1",
        status: "PENDING_REVIEW",
        version: 1,
        rejectionReason: null,
        createdWorksiteId: null,
      },
    ]
    const { db, journals, wasCommitted } = makeTransactionalFake({
      companyId: "co1",
      threadId: "th-1",
      drafts,
      messages: [
        { id: "m1", companyId: "co1", threadId: "th-1", draftId: "src" },
        { id: "m2", companyId: "co1", threadId: "th-1", draftId: "tgt" },
      ],
    })
    const origTx = db.$transaction.bind(db)
    db.$transaction = async (fn: (tx: never) => Promise<unknown>) =>
      origTx(async (tx) => {
        const t = tx as {
          worksiteImportDraft: {
            updateMany: () => Promise<{ count: number }>
          }
        }
        // count=0 mais état inchangé (encore REJECTABLE) → inconsistent
        t.worksiteImportDraft.updateMany = async () => ({ count: 0 })
        return fn(tx as never)
      }) as typeof db.$transaction

    await assert.rejects(
      () =>
        applyCancellationFollowUpTransactionally({
          companyId: "co1",
          sourceDraftId: "src",
          threadId: "th-1",
          frozen,
          actorUserId: null,
          db: db as never,
        }),
      (e: unknown) =>
        e instanceof Error &&
        e.message === "CANCELLATION_FOLLOWUP_STATE_INCONSISTENT"
    )
    assert.equal(wasCommitted(), false)
    assert.equal(journals.length, 0)
  })

  it("13 — erreur journal après mutation → rollback (sans hook prod)", async () => {
    const drafts: DraftRow[] = [
      {
        id: "src",
        companyId: "co1",
        status: "REJECTED",
        version: 2,
        rejectionReason: "X",
        createdWorksiteId: null,
      },
      {
        id: "tgt",
        companyId: "co1",
        status: "PENDING_REVIEW",
        version: 1,
        rejectionReason: null,
        createdWorksiteId: null,
      },
    ]
    const { db, journals, wasCommitted } = makeTransactionalFake({
      companyId: "co1",
      threadId: "th-1",
      drafts,
      messages: [
        { id: "m1", companyId: "co1", threadId: "th-1", draftId: "src" },
        { id: "m2", companyId: "co1", threadId: "th-1", draftId: "tgt" },
      ],
    })
    const origTx = db.$transaction.bind(db)
    db.$transaction = async (fn: (tx: never) => Promise<unknown>) =>
      origTx(async (tx) => {
        const t = tx as {
          acquisitionDecisionJournal: {
            create: (args: unknown) => Promise<unknown>
          }
        }
        t.acquisitionDecisionJournal.create = async () => {
          throw new Error("JOURNAL_WRITE_FORCED_FAIL")
        }
        return fn(tx as never)
      }) as typeof db.$transaction

    await assert.rejects(() =>
      applyCancellationFollowUpTransactionally({
        companyId: "co1",
        sourceDraftId: "src",
        threadId: "th-1",
        frozen,
        actorUserId: null,
        db: db as never,
      })
    )
    assert.equal(wasCommitted(), false)
    assert.equal(drafts[1]!.status, "PENDING_REVIEW")
    assert.equal(drafts[1]!.version, 1)
    assert.equal(journals.length, 0)
  })

  it("R2 — count=0 + CONVERTED sans worksite → throw, zéro journal", async () => {
    const drafts: DraftRow[] = [
      {
        id: "src",
        companyId: "co1",
        status: "REJECTED",
        version: 2,
        rejectionReason: "X",
        createdWorksiteId: null,
      },
      {
        id: "tgt",
        companyId: "co1",
        status: "PENDING_REVIEW",
        version: 1,
        rejectionReason: null,
        createdWorksiteId: null,
      },
    ]
    const { db, journals, wasCommitted } = makeTransactionalFake({
      companyId: "co1",
      threadId: "th-1",
      drafts,
      messages: [
        { id: "m1", companyId: "co1", threadId: "th-1", draftId: "src" },
        { id: "m2", companyId: "co1", threadId: "th-1", draftId: "tgt" },
      ],
    })
    const origTx = db.$transaction.bind(db)
    db.$transaction = async (fn: (tx: never) => Promise<unknown>) =>
      origTx(async (tx) => {
        const t = tx as {
          worksiteImportDraft: {
            updateMany: () => Promise<{ count: number }>
          }
          acquisitionMessage: { findMany: Function }
        }
        t.worksiteImportDraft.updateMany = async () => {
          drafts[1]!.status = "CONVERTED"
          drafts[1]!.createdWorksiteId = null
          return { count: 0 }
        }
        const origFind = t.acquisitionMessage.findMany.bind(t.acquisitionMessage)
        t.acquisitionMessage.findMany = async (args: unknown) => {
          const rows = await origFind(args)
          return rows.map((row: { id: string; draft: DraftRow | null }) => ({
            id: row.id,
            draft:
              row.draft == null
                ? null
                : drafts.find((d) => d.id === row.draft!.id) ?? row.draft,
          }))
        }
        return fn(tx as never)
      }) as typeof db.$transaction

    await assert.rejects(
      () =>
        applyCancellationFollowUpTransactionally({
          companyId: "co1",
          sourceDraftId: "src",
          threadId: "th-1",
          frozen,
          actorUserId: null,
          db: db as never,
        }),
      (e: unknown) =>
        e instanceof Error &&
        e.message === "CANCELLATION_FOLLOWUP_STATE_INCONSISTENT"
    )
    assert.equal(wasCommitted(), false)
    assert.equal(journals.length, 0)
  })

  it("14 — tenant isolation (messages filtrés companyId)", async () => {
    const drafts: DraftRow[] = [
      {
        id: "src",
        companyId: "co1",
        status: "REJECTED",
        version: 2,
        rejectionReason: "X",
        createdWorksiteId: null,
      },
      {
        id: "foreign",
        companyId: "co2",
        status: "PENDING_REVIEW",
        version: 1,
        rejectionReason: null,
        createdWorksiteId: null,
      },
    ]
    const { db, journals } = makeTransactionalFake({
      companyId: "co1",
      threadId: "th-1",
      drafts,
      messages: [
        { id: "m1", companyId: "co1", threadId: "th-1", draftId: "src" },
        // foreign company same thread id string — must be ignored by where.companyId
        { id: "m2", companyId: "co2", threadId: "th-1", draftId: "foreign" },
      ],
    })
    const r = await applyCancellationFollowUpTransactionally({
      companyId: "co1",
      sourceDraftId: "src",
      threadId: "th-1",
      frozen,
      actorUserId: null,
      db: db as never,
    })
    assert.equal(r.journalCode, "CANCELLATION_NO_LINK")
    assert.equal(drafts[1]!.status, "PENDING_REVIEW")
    assert.equal(journals[0]!.companyId, "co1")
  })
})

describe("CORRECTION-4B — worker wiring", () => {
  it("15 — worker utilise une seule API transactionnelle", () => {
    const src = readFileSync(WORKER_SRC, "utf8")
    assert.match(src, /applyCancellationFollowUpTransactionally/)
    const withoutTransactional = src.replace(
      /applyCancellationFollowUpTransactionally/g,
      ""
    )
    assert.equal(/applyCancellationFollowUp\b/.test(withoutTransactional), false)
  })

  it("16 — ancien flow race-check + append séparé absent", () => {
    const src = readFileSync(WORKER_SRC, "utf8")
    const cancelBlock = src.slice(
      src.indexOf("// --- NEEDS_CANCEL_FOLLOWUP ---"),
      src.indexOf("/** Scan intents AUTO_REJECT")
    )
    assert.equal(/findLatestCancellationFollowUpForCycle/.test(cancelBlock), false)
    assert.equal(/journal\.append\(/.test(cancelBlock), false)
    assert.equal(/Re-check race before journal/.test(cancelBlock), false)
    assert.match(cancelBlock, /applyCancellationFollowUpTransactionally/)
  })

  it("R2 — aucun hook test-only dans src/lib/acquisition", () => {
    const root = path.join(process.cwd(), "src/lib/acquisition")
    const stack = [root]
    const hits: string[] = []
    while (stack.length) {
      const dir = stack.pop()!
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) stack.push(p)
        else if (ent.isFile() && /\.(ts|tsx|js)$/.test(ent.name)) {
          const text = readFileSync(p, "utf8")
          if (
            text.includes("__testThrowAfterMutation") ||
            text.includes("__testAfterClassifyBeforeUpdate")
          ) {
            hits.push(p)
          }
        }
      }
    }
    assert.deepEqual(hits, [])
  })
})
