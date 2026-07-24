/**
 * Tests unitaires — cycle de vie Booking Gmail (C-BOOK-001).
 * Aucun appel Gmail / Anthropic.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type {
  BookingGmailMessageStatus,
  BookingGmailResultType,
  ProcessedGmailMessage,
} from "@prisma/client"
import {
  BookingGmailMessageLifecycle,
  BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED,
  computeNextRetryAt,
  getBookingGmailMaxAttempts,
} from "@/lib/booking/gmail-message-lifecycle"
import {
  classifyBookingError,
  permanentBookingError,
  sanitizeBookingErrorMessage,
} from "@/lib/booking/booking-gmail-errors"

const ACCOMMODATION_GMAIL_SOURCE_SQL = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260724120200_booking_accommodation_gmail_source/migration.sql"
  ),
  "utf8"
)

type Row = ProcessedGmailMessage

function makeFakeDb(): {
  api: NonNullable<ConstructorParameters<typeof BookingGmailMessageLifecycle>[0]>
  rows: Map<string, Row>
  key: (companyId: string, messageId: string) => string
} {
  const rows = new Map<string, Row>()
  const key = (companyId: string, messageId: string) => `${companyId}::${messageId}`

  const api = {
    processedGmailMessage: {
      async create({ data }: { data: Partial<Row> & { companyId: string; messageId: string } }) {
        const k = key(data.companyId, data.messageId)
        if (rows.has(k)) {
          const err = Object.assign(new Error("Unique"), { code: "P2002" })
          throw err
        }
        const row: Row = {
          id: `id_${rows.size + 1}`,
          companyId: data.companyId,
          messageId: data.messageId,
          processedAt: data.processedAt ?? new Date(),
          status: (data.status as BookingGmailMessageStatus) ?? "SUCCEEDED",
          attemptCount: data.attemptCount ?? 0,
          firstAttemptAt: data.firstAttemptAt ?? null,
          lastAttemptAt: data.lastAttemptAt ?? null,
          nextRetryAt: data.nextRetryAt ?? null,
          succeededAt: data.succeededAt ?? null,
          errorCode: data.errorCode ?? null,
          errorMessage: data.errorMessage ?? null,
          resultType: (data.resultType as BookingGmailResultType) ?? null,
          resultEntityId: data.resultEntityId ?? null,
          updatedAt: new Date(),
        }
        rows.set(k, row)
        return { ...row }
      },
      async findUnique({
        where,
      }: {
        where: { id?: string; companyId_messageId?: { companyId: string; messageId: string } }
      }) {
        if (where.id) {
          for (const r of rows.values()) if (r.id === where.id) return { ...r }
          return null
        }
        const ck = where.companyId_messageId!
        return rows.has(key(ck.companyId, ck.messageId))
          ? { ...rows.get(key(ck.companyId, ck.messageId))! }
          : null
      },
      async findUniqueOrThrow(args: {
        where: { id?: string; companyId_messageId?: { companyId: string; messageId: string } }
      }) {
        const r = await api.processedGmailMessage.findUnique(args)
        if (!r) throw new Error("Not found")
        return r
      },
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) {
        let count = 0
        for (const [k, row] of rows) {
          let ok = true
          if (where.id && row.id !== where.id) ok = false
          if (where.companyId && row.companyId !== where.companyId) ok = false
          if (where.messageId && row.messageId !== where.messageId) ok = false
          if (where.status && row.status !== where.status) ok = false
          if (
            where.attemptCount !== undefined &&
            row.attemptCount !== where.attemptCount
          )
            ok = false
          if (Array.isArray(where.OR)) {
            const orOk = (where.OR as Array<Record<string, unknown>>).some((clause) => {
              if ("lastAttemptAt" in clause) {
                const cond = clause.lastAttemptAt
                if (cond === null) return row.lastAttemptAt === null
                if (cond && typeof cond === "object" && "lte" in cond) {
                  const lte = (cond as { lte: Date }).lte
                  return row.lastAttemptAt !== null && row.lastAttemptAt <= lte
                }
              }
              return false
            })
            if (!orOk) ok = false
          } else if (
            "lastAttemptAt" in where &&
            where.lastAttemptAt !== undefined &&
            row.lastAttemptAt?.getTime() !== (where.lastAttemptAt as Date | null)?.getTime()
          ) {
            ok = false
          }
          if (!ok) continue
          const next = { ...row, updatedAt: new Date() }
          if (typeof data.attemptCount === "object" && data.attemptCount && "increment" in (data.attemptCount as object)) {
            next.attemptCount += (data.attemptCount as { increment: number }).increment
          } else if (typeof data.attemptCount === "number") {
            next.attemptCount = data.attemptCount
          }
          for (const [field, val] of Object.entries(data)) {
            if (field === "attemptCount") continue
            ;(next as Record<string, unknown>)[field] = val
          }
          rows.set(k, next)
          count++
        }
        return { count }
      },
      async update({ where, data }: { where: { id?: string; companyId_messageId?: { companyId: string; messageId: string } }; data: Partial<Row> }) {
        let row: Row | undefined
        if (where.id) row = [...rows.values()].find((r) => r.id === where.id)
        else if (where.companyId_messageId) {
          row = rows.get(
            key(where.companyId_messageId.companyId, where.companyId_messageId.messageId)
          )
        }
        if (!row) throw new Error("Not found")
        const next = { ...row, ...data, updatedAt: new Date() }
        rows.set(key(next.companyId, next.messageId), next)
        return { ...next }
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(api),
  }

  return {
    api: api as unknown as NonNullable<
      ConstructorParameters<typeof BookingGmailMessageLifecycle>[0]
    >,
    rows,
    key,
  }
}

describe("booking-gmail-errors", () => {
  it("sanitize redacts bearer tokens", () => {
    const s = sanitizeBookingErrorMessage("fail Bearer abc.def.ghi more")
    assert.ok(!s.includes("abc.def"))
    assert.ok(s.includes("[redacted]"))
  })

  it("classifies empty body as permanent", () => {
    const c = classifyBookingError(new Error("EMPTY_MESSAGE_BODY"))
    assert.equal(c.kind, "PERMANENT")
    assert.equal(c.code, "EMPTY_MESSAGE_BODY")
  })

  it("classifies network as retryable", () => {
    const c = classifyBookingError(new Error("fetch failed ETIMEDOUT"))
    assert.equal(c.kind, "RETRYABLE")
  })
})

describe("booking gmail lifecycle", () => {
  let fake!: ReturnType<typeof makeFakeDb>
  let life!: BookingGmailMessageLifecycle

  beforeEach(() => {
    process.env.BOOKING_GMAIL_MAX_ATTEMPTS = "3"
    process.env.BOOKING_GMAIL_PROCESSING_STALE_MS = String(15 * 60 * 1000)
    fake = makeFakeDb()
    life = new BookingGmailMessageLifecycle(fake.api)
  })

  it("1. nouveau message → PROCESSING claim", async () => {
    const claim = await life.claimForProcessing("coA", "msg1")
    assert.equal(claim.action, "CLAIMED")
    if (claim.action === "CLAIMED") {
      assert.equal(claim.record.status, "PROCESSING")
      assert.equal(claim.record.attemptCount, 1)
      assert.equal(claim.isNew, true)
    }
  })

  it("6. SUCCEEDED ignoré", async () => {
    await fake.api.processedGmailMessage.create({
      data: {
        companyId: "coA",
        messageId: "msgS",
        status: "SUCCEEDED",
        attemptCount: 1,
        succeededAt: new Date(),
      },
    })
    const claim = await life.claimForProcessing("coA", "msgS")
    assert.deepEqual(claim, { action: "SKIP", reason: "SUCCEEDED" })
  })

  it("7. PERMANENTLY_IGNORED ignoré", async () => {
    await fake.api.processedGmailMessage.create({
      data: {
        companyId: "coA",
        messageId: "msgP",
        status: "PERMANENTLY_IGNORED",
        attemptCount: 1,
        errorCode: "EMPTY_MESSAGE_BODY",
      },
    })
    const claim = await life.claimForProcessing("coA", "msgP")
    assert.deepEqual(claim, { action: "SKIP", reason: "PERMANENTLY_IGNORED" })
  })

  it("12. ancienne ligne SUCCEEDED (compat) non retraitée", async () => {
    await fake.api.processedGmailMessage.create({
      data: {
        companyId: "coA",
        messageId: "legacy",
        status: "SUCCEEDED",
        attemptCount: 1,
        processedAt: new Date("2026-06-01"),
        succeededAt: new Date("2026-06-01"),
      },
    })
    const claim = await life.claimForProcessing("coA", "legacy")
    assert.equal(claim.action, "SKIP")
  })

  it("3+4. erreur → RETRYABLE puis nouvelle tentative", async () => {
    await life.claimForProcessing("coA", "msgR")
    const failed = await life.markFailure({
      companyId: "coA",
      messageId: "msgR",
      error: new Error("fetch failed timeout"),
      now: new Date("2026-07-20T10:00:00Z"),
    })
    assert.equal(failed.status, "RETRYABLE_FAILURE")
    assert.ok(failed.nextRetryAt)

    const tooEarly = await life.claimForProcessing(
      "coA",
      "msgR",
      new Date("2026-07-20T10:01:00Z")
    )
    assert.equal(tooEarly.action, "SKIP")

    const due = await life.claimForProcessing(
      "coA",
      "msgR",
      failed.nextRetryAt!
    )
    assert.equal(due.action, "CLAIMED")
    if (due.action === "CLAIMED") assert.equal(due.record.attemptCount, 2)
  })

  it("5. max tentatives → PERMANENTLY_IGNORED", async () => {
    assert.equal(getBookingGmailMaxAttempts(), 3)
    await life.claimForProcessing("coA", "msgM")
    await life.markFailure({
      companyId: "coA",
      messageId: "msgM",
      error: new Error("timeout"),
      now: new Date("2026-07-20T10:00:00Z"),
    })
    // attemptCount still 1; claim again twice more
    for (let i = 0; i < 2; i++) {
      const row = await fake.api.processedGmailMessage.findUnique({
        where: { companyId_messageId: { companyId: "coA", messageId: "msgM" } },
      })
      const claim = await life.claimForProcessing(
        "coA",
        "msgM",
        row!.nextRetryAt ?? new Date()
      )
      assert.equal(claim.action, "CLAIMED")
      await life.markFailure({
        companyId: "coA",
        messageId: "msgM",
        error: new Error("timeout"),
        now: new Date(),
      })
    }
    const final = await fake.api.processedGmailMessage.findUnique({
      where: { companyId_messageId: { companyId: "coA", messageId: "msgM" } },
    })
    assert.equal(final?.status, "PERMANENTLY_IGNORED")
  })

  it("8+14. concurrence même messageId — deux companies isolées ; double claim même company", async () => {
    const a = await life.claimForProcessing("coA", "sharedMsg")
    const b = await life.claimForProcessing("coB", "sharedMsg")
    assert.equal(a.action, "CLAIMED")
    assert.equal(b.action, "CLAIMED")

    const again = await life.claimForProcessing("coA", "sharedMsg")
    assert.equal(again.action, "SKIP")
    assert.equal(again.action === "SKIP" && again.reason, "IN_FLIGHT")
  })

  it("11. récupération PROCESSING obsolète", async () => {
    const staleTime = new Date(Date.now() - 20 * 60 * 1000)
    await fake.api.processedGmailMessage.create({
      data: {
        companyId: "coA",
        messageId: "stale",
        status: "PROCESSING",
        attemptCount: 1,
        firstAttemptAt: staleTime,
        lastAttemptAt: staleTime,
      },
    })
    const claim = await life.claimForProcessing("coA", "stale")
    assert.equal(claim.action, "CLAIMED")
    if (claim.action === "CLAIMED") assert.equal(claim.record.attemptCount, 2)
  })

  it("permanent ignore helper", async () => {
    await life.claimForProcessing("coA", "empty")
    const row = await life.markPermanentIgnored(
      "coA",
      "empty",
      permanentBookingError("EMPTY_MESSAGE_BODY", "vide")
    )
    assert.equal(row.status, "PERMANENTLY_IGNORED")
    assert.equal(row.resultType, "IGNORED")
  })

  it("computeNextRetryAt backoff", () => {
    const t0 = new Date("2026-07-20T00:00:00Z")
    const t1 = computeNextRetryAt(1, t0)
    const t2 = computeNextRetryAt(2, t0)
    assert.ok(t2.getTime() > t1.getTime())
  })

  it("9+10. markSucceededInTransaction — appelle la fonction (résultat + SUCCEEDED conditionnel)", async () => {
    await life.claimForProcessing("coA", "tx1")

    let sawTxClient = false
    const row = await life.markSucceededInTransaction(
      { companyId: "coA", messageId: "tx1" },
      async (tx) => {
        sawTxClient = Boolean(tx?.processedGmailMessage?.updateMany)
        // Même contexte transactionnel que le marquage SUCCEEDED
        assert.equal(typeof tx.processedGmailMessage.updateMany, "function")
        return {
          resultType: "PENDING_ACCOMMODATION",
          resultEntityId: "pending_1",
        }
      },
      fake.api as unknown as import("@prisma/client").PrismaClient
    )
    assert.equal(sawTxClient, true)
    assert.equal(row.status, "SUCCEEDED")
    assert.equal(row.resultType, "PENDING_ACCOMMODATION")
    assert.equal(row.resultEntityId, "pending_1")

    // SUCCEEDED conditionnel à PROCESSING : second passage échoue
    await assert.rejects(
      () =>
        life.markSucceededInTransaction(
          { companyId: "coA", messageId: "tx1" },
          async () => ({
            resultType: "PENDING_ACCOMMODATION",
            resultEntityId: "pending_2",
          }),
          fake.api as unknown as import("@prisma/client").PrismaClient
        ),
      (err: unknown) =>
        err instanceof Error &&
        err.message === BOOKING_GMAIL_SUCCESS_STATUS_UPDATE_FAILED
    )
  })

  it("9+10b. markSucceededInTransaction — erreur métier empêche SUCCEEDED", async () => {
    await life.claimForProcessing("coA", "txFail")
    await assert.rejects(
      () =>
        life.markSucceededInTransaction(
          { companyId: "coA", messageId: "txFail" },
          async () => {
            throw new Error("SIMULATED_CREATE_FAIL")
          },
          fake.api as unknown as import("@prisma/client").PrismaClient
        ),
      /SIMULATED_CREATE_FAIL/
    )
    const row = await fake.api.processedGmailMessage.findUnique({
      where: { companyId_messageId: { companyId: "coA", messageId: "txFail" } },
    })
    assert.equal(row?.status, "PROCESSING")
    assert.equal(row?.resultEntityId, null)
  })

  it("markFailure n'écrase pas SUCCEEDED", async () => {
    await life.claimForProcessing("coA", "race")
    await fake.api.processedGmailMessage.updateMany({
      where: { companyId: "coA", messageId: "race", status: "PROCESSING" },
      data: {
        status: "SUCCEEDED",
        succeededAt: new Date(),
        resultType: "ACCOMMODATION",
        resultEntityId: "acc1",
      },
    })
    const row = await life.markFailure({
      companyId: "coA",
      messageId: "race",
      error: new Error("timeout"),
    })
    assert.equal(row.status, "SUCCEEDED")
  })

  it("13. pas de double claim après succès", async () => {
    await life.claimForProcessing("coA", "once")
    await fake.api.processedGmailMessage.updateMany({
      where: { companyId: "coA", messageId: "once", status: "PROCESSING" },
      data: {
        status: "SUCCEEDED",
        succeededAt: new Date(),
        resultType: "ACCOMMODATION",
        resultEntityId: "acc_1",
      },
    })
    const again = await life.claimForProcessing("coA", "once")
    assert.deepEqual(again, { action: "SKIP", reason: "SUCCEEDED" })
  })
})

describe("migration accommodations gmailSourceMessageId SQL (préflight)", () => {
  it("préflight fail-closed, aucun DELETE, unicité tenant, NULL exclus", () => {
    assert.equal(/^\s*DELETE\b/im.test(ACCOMMODATION_GMAIL_SOURCE_SQL), false)
    assert.match(ACCOMMODATION_GMAIL_SOURCE_SQL, /RAISE EXCEPTION/)
    assert.match(
      ACCOMMODATION_GMAIL_SOURCE_SQL,
      /gmailSourceMessageId"\s+IS NOT NULL/
    )
    assert.match(
      ACCOMMODATION_GMAIL_SOURCE_SQL,
      /CREATE UNIQUE INDEX "accommodations_companyId_gmailSourceMessageId_key"/
    )
    assert.match(
      ACCOMMODATION_GMAIL_SOURCE_SQL,
      /ON "accommodations"\("companyId", "gmailSourceMessageId"\)/
    )
    assert.match(
      ACCOMMODATION_GMAIL_SOURCE_SQL,
      /groupe\(s\) de doublons accommodations/
    )
  })
})
