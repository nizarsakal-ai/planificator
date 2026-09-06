/**
 * PLAN-ACQ-AGENTS-LOT-3D/3E-CORRECTION-4B — concurrence PostgreSQL réelle.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient, type Prisma } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { seedLauraluPartnerForCompany } from "./helpers/seed-lauralu-partner"
import { applyCancellationFollowUpTransactionally, acquireCancellationThreadAdvisoryXactLock } from "@/lib/acquisition/policy/cancellation-followup"
import {
  buildCancellationFollowUpIdempotencyKey,
  type FrozenValidationCycle,
} from "@/lib/acquisition/policy/decision-journal.repository"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const RUN = {
  skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini",
}

/**
 * Wrapper test-only (hors production) : intercepte le TransactionClient passé
 * au callback `$transaction` sans seam dans le code métier.
 */
function wrapPrismaForTxHooks(
  client: PrismaClient,
  hooks: {
    /** Après le 1er findMany acquisitionMessage (classification). */
    afterFirstThreadRead?: () => Promise<void>
    /** Remplace journal.create par un throw (après mutation éventuelle). */
    failJournalCreate?: boolean
  }
): PrismaClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") {
        return Reflect.get(target, prop, receiver)
      }
      return async <T>(
        fn: (tx: Prisma.TransactionClient) => Promise<T>
      ): Promise<T> => {
        let threadReads = 0
        return target.$transaction(async (tx) => {
          const proxied = new Proxy(tx, {
            get(txTarget, txProp, txReceiver) {
              if (txProp === "acquisitionMessage") {
                return new Proxy(txTarget.acquisitionMessage, {
                  get(msg, msgProp, msgReceiver) {
                    if (msgProp === "findMany") {
                      return async (...args: unknown[]) => {
                        const rows = await (
                          txTarget.acquisitionMessage.findMany as (
                            ...a: unknown[]
                          ) => Promise<unknown>
                        )(...args)
                        threadReads++
                        if (threadReads === 1 && hooks.afterFirstThreadRead) {
                          await hooks.afterFirstThreadRead()
                        }
                        return rows
                      }
                    }
                    return Reflect.get(msg, msgProp, msgReceiver)
                  },
                })
              }
              if (txProp === "acquisitionDecisionJournal") {
                return new Proxy(txTarget.acquisitionDecisionJournal, {
                  get(j, jProp, jReceiver) {
                    if (jProp === "create" && hooks.failJournalCreate) {
                      return async () => {
                        throw new Error("JOURNAL_WRITE_FORCED_FAIL")
                      }
                    }
                    return Reflect.get(j, jProp, jReceiver)
                  },
                })
              }
              return Reflect.get(txTarget, txProp, txReceiver)
            },
          }) as Prisma.TransactionClient
          return fn(proxied)
        })
      }
    },
  }) as PrismaClient
}

describe("CORRECTION-4B — PostgreSQL transactional follow-up", RUN, () => {
  const stamp = Date.now()
  let companyId = ""
  let sourceDraftId = ""
  let targetDraftId = ""
  let threadId = ""
  let dbA: PrismaClient
  let dbB: PrismaClient

  const frozen: FrozenValidationCycle = {
    contentHash: "cancel-hash",
    extractionSchemaVersion: "2",
    validatedDraftVersion: 1,
  }

  before(async () => {
    dbA = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    dbB = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    const company = await dbA.company.create({
      data: { name: "Cancel Co", slug: `cancel-fu-${stamp}` },
    })
    companyId = company.id
    await seedLauraluPartnerForCompany(dbA, companyId)
    threadId = `thread-cancel-${stamp}`

    const src = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-src-${stamp}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Cancel source",
        receivedAt: new Date(),
        attachments: [],
      },
      dbA
    )
    assert.ok(src.draftId)
    sourceDraftId = src.draftId!

    const tgt = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-tgt-${stamp}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Cancel target",
        receivedAt: new Date(),
        attachments: [],
      },
      dbA
    )
    assert.ok(tgt.draftId)
    targetDraftId = tgt.draftId!

    await dbA.acquisitionMessage.updateMany({
      where: { companyId, id: { in: [src.messageId, tgt.messageId] } },
      data: { threadId },
    })

    await dbA.worksiteImportDraft.update({
      where: { id: sourceDraftId },
      data: {
        status: "REJECTED",
        rejectionReason: "CANCELLED_INITIAL",
        version: 1,
        contentHashAtExtraction: frozen.contentHash,
        extractionSchemaVersion: frozen.extractionSchemaVersion,
      },
    })
    await dbA.worksiteImportDraft.update({
      where: { id: targetDraftId },
      data: {
        status: "PENDING_REVIEW",
        version: 1,
        contentHashAtExtraction: "tgt-hash",
        extractionSchemaVersion: "2",
      },
    })
  })

  after(async () => {
    if (!enabled) return
    await dbA.acquisitionDecisionJournal.deleteMany({ where: { companyId } })
    await dbA.worksiteImportDraft.deleteMany({ where: { companyId } })
    await dbA.acquisitionMessageContent.deleteMany({ where: { companyId } })
    await dbA.acquisitionMessage.deleteMany({ where: { companyId } })
    await dbA.acquisitionPartnerDomain.deleteMany({ where: { companyId } })
    await dbA.acquisitionPartner.deleteMany({ where: { companyId } })
    await dbA.company.deleteMany({ where: { id: companyId } })
    await dbA.$disconnect()
    await dbB.$disconnect()
  })

  it("A — deux 4B concurrentes → une seule mutation + un journal APPLIED", async () => {
    const [r1, r2] = await Promise.all([
      applyCancellationFollowUpTransactionally({
        companyId,
        sourceDraftId,
        threadId,
        frozen,
        actorUserId: null,
        db: dbA,
      }),
      applyCancellationFollowUpTransactionally({
        companyId,
        sourceDraftId,
        threadId,
        frozen,
        actorUserId: null,
        db: dbB,
      }),
    ])

    assert.equal(r1.journalCode, "CANCELLATION_FOLLOWUP_APPLIED")
    assert.equal(r2.journalCode, "CANCELLATION_FOLLOWUP_APPLIED")
    const outcomes = [r1.outcome, r2.outcome].sort()
    assert.deepEqual(outcomes, ["ALREADY_EXISTS", "APPENDED"])

    const target = await dbA.worksiteImportDraft.findUniqueOrThrow({
      where: { id: targetDraftId },
    })
    assert.equal(target.status, "REJECTED")
    assert.equal(target.rejectionReason, "CANCELLED_BY_FOLLOWUP")
    assert.equal(target.version, 2)

    const key = buildCancellationFollowUpIdempotencyKey({
      companyId,
      sourceDraftId,
      frozen,
    })
    const rows = await dbA.acquisitionDecisionJournal.findMany({
      where: { companyId, draftId: sourceDraftId, idempotencyKey: key },
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.decisionCode, "CANCELLATION_FOLLOWUP_APPLIED")
    assert.equal(
      rows.some((r) => r.decisionCode === "CANCELLATION_NO_LINK"),
      false
    )
  })

  it("B — erreur journal après mutation → rollback draft + zéro journal", async () => {
    const stampB = `${stamp}-b`
    const threadB = `thread-rollback-${stampB}`
    const src = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-rb-src-${stampB}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "RB source",
        receivedAt: new Date(),
        attachments: [],
      },
      dbA
    )
    const tgt = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-rb-tgt-${stampB}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "RB target",
        receivedAt: new Date(),
        attachments: [],
      },
      dbA
    )
    assert.ok(src.draftId && tgt.draftId)
    await dbA.acquisitionMessage.updateMany({
      where: { companyId, id: { in: [src.messageId, tgt.messageId] } },
      data: { threadId: threadB },
    })
    await dbA.worksiteImportDraft.update({
      where: { id: src.draftId },
      data: { status: "REJECTED", rejectionReason: "CANCELLED_INITIAL", version: 1 },
    })
    await dbA.worksiteImportDraft.update({
      where: { id: tgt.draftId },
      data: { status: "PENDING_REVIEW", version: 5 },
    })

    const frozenB: FrozenValidationCycle = {
      contentHash: "rb-hash",
      extractionSchemaVersion: "2",
      validatedDraftVersion: 1,
    }

    const dbFailJournal = wrapPrismaForTxHooks(dbA, { failJournalCreate: true })

    await assert.rejects(() =>
      applyCancellationFollowUpTransactionally({
        companyId,
        sourceDraftId: src.draftId!,
        threadId: threadB,
        frozen: frozenB,
        actorUserId: null,
        db: dbFailJournal,
      })
    )

    const target = await dbA.worksiteImportDraft.findUniqueOrThrow({
      where: { id: tgt.draftId! },
    })
    assert.equal(target.status, "PENDING_REVIEW")
    assert.equal(target.version, 5)

    const key = buildCancellationFollowUpIdempotencyKey({
      companyId,
      sourceDraftId: src.draftId!,
      frozen: frozenB,
    })
    const rows = await dbA.acquisitionDecisionJournal.findMany({
      where: { companyId, draftId: src.draftId!, idempotencyKey: key },
    })
    assert.equal(rows.length, 0)
  })

  it("C — locks thread-A et thread-B distincts (barrière, pas Promise.all seul)", async () => {
    const stampC = `${stamp}-c`
    async function setupThread(suffix: string) {
      const th = `thread-indep-${suffix}`
      const s = await registerIncomingMessage(
        {
          companyId,
          source: "GMAIL",
          externalMessageId: `ext-ind-src-${suffix}`,
          senderEmail: "carlene@lauralu.fr",
          subject: `Ind src ${suffix}`,
          receivedAt: new Date(),
          attachments: [],
        },
        dbA
      )
      const t = await registerIncomingMessage(
        {
          companyId,
          source: "GMAIL",
          externalMessageId: `ext-ind-tgt-${suffix}`,
          senderEmail: "carlene@lauralu.fr",
          subject: `Ind tgt ${suffix}`,
          receivedAt: new Date(),
          attachments: [],
        },
        dbA
      )
      assert.ok(s.draftId && t.draftId)
      await dbA.acquisitionMessage.updateMany({
        where: { companyId, id: { in: [s.messageId, t.messageId] } },
        data: { threadId: th },
      })
      await dbA.worksiteImportDraft.update({
        where: { id: s.draftId },
        data: { status: "REJECTED", rejectionReason: "CANCELLED_INITIAL", version: 1 },
      })
      await dbA.worksiteImportDraft.update({
        where: { id: t.draftId },
        data: { status: "PENDING_REVIEW", version: 1 },
      })
      return {
        threadId: th,
        sourceDraftId: s.draftId!,
        targetDraftId: t.draftId!,
        frozen: {
          contentHash: `ind-${suffix}`,
          extractionSchemaVersion: "2",
          validatedDraftVersion: 1,
        } satisfies FrozenValidationCycle,
      }
    }

    const a = await setupThread(`${stampC}-a`)
    const b = await setupThread(`${stampC}-b`)

    let releaseA!: () => void
    const aHold = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    let aHoldsLock = false
    let bAcquiredWhileAHeld = false

    const aTx = dbA.$transaction(async (tx) => {
      await acquireCancellationThreadAdvisoryXactLock(
        tx,
        companyId,
        a.threadId
      )
      aHoldsLock = true
      await aHold
      return "A_DONE"
    })

    // Attendre que A détienne réellement son lock
    for (let i = 0; i < 200 && !aHoldsLock; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.equal(aHoldsLock, true)

    // Pendant qu’A détient thread-A, B doit acquérir thread-B sans attendre A
    await dbB.$transaction(async (tx) => {
      await acquireCancellationThreadAdvisoryXactLock(
        tx,
        companyId,
        b.threadId
      )
      assert.equal(aHoldsLock, true)
      bAcquiredWhileAHeld = true
    })
    assert.equal(bAcquiredWhileAHeld, true)

    releaseA()
    assert.equal(await aTx, "A_DONE")

    // Effets métier indépendants (toujours sur locks distincts)
    const [ra, rb] = await Promise.all([
      applyCancellationFollowUpTransactionally({
        companyId,
        sourceDraftId: a.sourceDraftId,
        threadId: a.threadId,
        frozen: a.frozen,
        actorUserId: null,
        db: dbA,
      }),
      applyCancellationFollowUpTransactionally({
        companyId,
        sourceDraftId: b.sourceDraftId,
        threadId: b.threadId,
        frozen: b.frozen,
        actorUserId: null,
        db: dbB,
      }),
    ])
    assert.equal(ra.journalCode, "CANCELLATION_FOLLOWUP_APPLIED")
    assert.equal(rb.journalCode, "CANCELLATION_FOLLOWUP_APPLIED")
  })

  it("D — course hors protocole : count=0 → TARGET_AMBIGUOUS (≠ ancien fallback NO_LINK)", async () => {
    const stampD = `${stamp}-d`
    const threadD = `thread-race-${stampD}`
    const src = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-race-src-${stampD}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Race source",
        receivedAt: new Date(),
        attachments: [],
      },
      dbA
    )
    const tgt = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-race-tgt-${stampD}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Race target",
        receivedAt: new Date(),
        attachments: [],
      },
      dbA
    )
    assert.ok(src.draftId && tgt.draftId)
    await dbA.acquisitionMessage.updateMany({
      where: { companyId, id: { in: [src.messageId, tgt.messageId] } },
      data: { threadId: threadD },
    })
    await dbA.worksiteImportDraft.update({
      where: { id: src.draftId },
      data: { status: "REJECTED", rejectionReason: "CANCELLED_INITIAL", version: 1 },
    })
    await dbA.worksiteImportDraft.update({
      where: { id: tgt.draftId },
      data: { status: "PENDING_REVIEW", version: 1 },
    })

    const frozenD: FrozenValidationCycle = {
      contentHash: "race-hash",
      extractionSchemaVersion: "2",
      validatedDraftVersion: 1,
    }

    let extraDraftIds: string[] = []
    const dbRace = wrapPrismaForTxHooks(dbA, {
      afterFirstThreadRead: async () => {
        // 1) Cible initiale hors REJECTABLE → update 4B count=0
        await dbB.worksiteImportDraft.updateMany({
          where: { id: tgt.draftId!, companyId },
          data: {
            status: "REJECTED",
            rejectionReason: "HUMAN_OUT_OF_BAND",
            version: { increment: 1 },
          },
        })
        // 2) Deux nouvelles cibles rejectable sur le même thread → état frais AMBIGUOUS
        //    (différent de NO_LINK : l’ancien fallback count=0→NO_LINK échouerait ici).
        for (const suffix of ["a", "b"] as const) {
          const extra = await registerIncomingMessage(
            {
              companyId,
              source: "GMAIL",
              externalMessageId: `ext-race-extra-${suffix}-${stampD}`,
              senderEmail: "carlene@lauralu.fr",
              subject: `Race extra ${suffix}`,
              receivedAt: new Date(),
              attachments: [],
            },
            dbB
          )
          assert.ok(extra.draftId)
          await dbB.acquisitionMessage.update({
            where: { id: extra.messageId },
            data: { threadId: threadD },
          })
          await dbB.worksiteImportDraft.update({
            where: { id: extra.draftId },
            data: { status: "PENDING_REVIEW", version: 1 },
          })
          extraDraftIds.push(extra.draftId!)
        }
      },
    })

    const r = await applyCancellationFollowUpTransactionally({
      companyId,
      sourceDraftId: src.draftId!,
      threadId: threadD,
      frozen: frozenD,
      actorUserId: null,
      db: dbRace,
    })

    // Classification fraîche après count=0 — PAS le fallback historique NO_LINK.
    assert.equal(r.journalCode, "CANCELLATION_TARGET_AMBIGUOUS")
    assert.notEqual(r.journalCode, "CANCELLATION_NO_LINK")
    assert.notEqual(r.journalCode, "CANCELLATION_FOLLOWUP_APPLIED")
    assert.equal(r.outcome, "APPENDED")
    assert.equal(r.ambiguous, true)
    assert.deepEqual(r.linkedDraftIdsRejected, [])

    const key = buildCancellationFollowUpIdempotencyKey({
      companyId,
      sourceDraftId: src.draftId!,
      frozen: frozenD,
    })
    const rows = await dbA.acquisitionDecisionJournal.findMany({
      where: { companyId, draftId: src.draftId!, idempotencyKey: key },
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.decisionCode, "CANCELLATION_TARGET_AMBIGUOUS")

    // Preuve count=0 path : cible initiale non mutée par 4B (raison hors-bande).
    const originalTarget = await dbA.worksiteImportDraft.findUniqueOrThrow({
      where: { id: tgt.draftId! },
    })
    assert.equal(originalTarget.status, "REJECTED")
    assert.equal(originalTarget.rejectionReason, "HUMAN_OUT_OF_BAND")

    // Aucune mutation follow-up fantôme sur les extras rejectable.
    assert.equal(extraDraftIds.length, 2)
    for (const id of extraDraftIds) {
      const d = await dbA.worksiteImportDraft.findUniqueOrThrow({ where: { id } })
      assert.equal(d.status, "PENDING_REVIEW")
      assert.notEqual(d.rejectionReason, "CANCELLED_BY_FOLLOWUP")
    }
  })
})
