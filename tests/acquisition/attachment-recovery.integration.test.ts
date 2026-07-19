// Tests d'intégration PLAN-ACQ-004D — Recovery / Retry / markFailure conditionnel.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { AcquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { RETRYABLE_ATTACHMENT_ERROR_CODES } from "@/lib/acquisition/attachments/attachment-retry.policy"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

describe("acquisition attachment recovery — intégration", RUN, () => {
  let companyA = ""
  let companyB = ""
  let messageA = ""
  let messageB = ""
  let repo: AcquisitionAttachmentRepository

  before(async () => {
    const a = await db.company.create({
      data: { name: "Rec A", slug: `rec-a-${Date.now()}` },
    })
    const b = await db.company.create({
      data: { name: "Rec B", slug: `rec-b-${Date.now()}` },
    })
    companyA = a.id
    companyB = b.id

    const msgA = await db.acquisitionMessage.create({
      data: {
        companyId: companyA,
        source: "GMAIL",
        externalMessageId: `ext-rec-a-${Date.now()}`,
        senderEmail: "a@test.fr",
        senderDomain: "test.fr",
        subject: "rec",
        receivedAt: new Date(),
        status: "RECEIVED",
      },
    })
    const msgB = await db.acquisitionMessage.create({
      data: {
        companyId: companyB,
        source: "GMAIL",
        externalMessageId: `ext-rec-b-${Date.now()}`,
        senderEmail: "b@test.fr",
        senderDomain: "test.fr",
        subject: "rec",
        receivedAt: new Date(),
        status: "RECEIVED",
      },
    })
    messageA = msgA.id
    messageB = msgB.id
    repo = new AcquisitionAttachmentRepository(db)
  })

  after(async () => {
    await db.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await db.$disconnect()
  })

  async function createAttachment(
    companyId: string,
    messageId: string,
    key: string,
    data: Record<string, unknown> = {}
  ) {
    return db.acquisitionAttachment.create({
      data: {
        companyId,
        acquisitionMessageId: messageId,
        attachmentKey: key,
        filename: "plan.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        status: "DISCOVERED",
        ...data,
      },
    })
  }

  it("claim pose downloadClaimedAt", async () => {
    const att = await createAttachment(companyA, messageA, `claim-${Date.now()}`)
    const claim = await repo.claimForDownload(companyA, att.id)
    assert.equal(claim.status, "CLAIMED")
    if (claim.status !== "CLAIMED") return
    assert.ok(claim.attachment.downloadClaimedAt)
    const row = await db.acquisitionAttachment.findFirstOrThrow({ where: { id: att.id } })
    assert.ok(row.downloadClaimedAt)
  })

  it("PENDING frais non reclaimé ; expiré reclaimé", async () => {
    const fresh = await createAttachment(companyA, messageA, `fresh-${Date.now()}`, {
      status: "PENDING_DOWNLOAD",
      downloadClaimedAt: new Date(),
    })
    const stale = await createAttachment(companyA, messageA, `stale-${Date.now()}`, {
      status: "PENDING_DOWNLOAD",
      downloadClaimedAt: new Date(Date.now() - 60 * 60_000),
    })
    const olderThan = new Date(Date.now() - 30 * 60_000)
    assert.equal(
      await repo.reclaimPendingDownload({
        companyId: companyA,
        attachmentId: fresh.id,
        olderThan,
      }),
      "NOOP"
    )
    assert.equal(
      await repo.reclaimPendingDownload({
        companyId: companyA,
        attachmentId: stale.id,
        olderThan,
      }),
      "RECLAIMED"
    )
    const row = await db.acquisitionAttachment.findFirstOrThrow({ where: { id: stale.id } })
    assert.equal(row.status, "DISCOVERED")
    assert.equal(row.downloadClaimedAt, null)
  })

  it("double reclaim → un seul RECLAIMED", async () => {
    const stale = await createAttachment(companyA, messageA, `dbl-rec-${Date.now()}`, {
      status: "PENDING_DOWNLOAD",
      downloadClaimedAt: new Date(Date.now() - 60 * 60_000),
    })
    const olderThan = new Date(Date.now() - 30 * 60_000)
    const [a, b] = await Promise.all([
      repo.reclaimPendingDownload({ companyId: companyA, attachmentId: stale.id, olderThan }),
      repo.reclaimPendingDownload({ companyId: companyA, attachmentId: stale.id, olderThan }),
    ])
    const wins = [a, b].filter((x) => x === "RECLAIMED")
    assert.equal(wins.length, 1)
  })

  it("markFailure FAILED incrémente ; REJECTED non ; STORED protégé", async () => {
    const pending = await createAttachment(companyA, messageA, `fail-${Date.now()}`)
    await repo.claimForDownload(companyA, pending.id)

    const failed = await repo.markFailure(companyA, pending.id, {
      status: "FAILED",
      errorCode: "ATTACHMENT_STORAGE_FAILED",
      failedAt: new Date(),
      nextRetryAt: new Date(Date.now() + 60_000),
    })
    assert.equal(failed.outcome, "MARKED_FAILED")
    if (failed.outcome !== "MARKED_FAILED") return
    assert.equal(failed.attachment.downloadRetryCount, 1)
    assert.ok(failed.attachment.downloadNextRetryAt)

    const again = await repo.markFailure(companyA, pending.id, {
      status: "FAILED",
      errorCode: "ATTACHMENT_STORAGE_FAILED",
      failedAt: new Date(),
      nextRetryAt: new Date(),
    })
    assert.equal(again.outcome, "STATE_CHANGED")

    const rejectedPending = await createAttachment(companyA, messageA, `rej-${Date.now()}`)
    await repo.claimForDownload(companyA, rejectedPending.id)
    const rej = await repo.markFailure(companyA, rejectedPending.id, {
      status: "REJECTED",
      errorCode: "ATTACHMENT_TOO_LARGE",
      failedAt: new Date(),
      nextRetryAt: new Date(),
    })
    assert.equal(rej.outcome, "MARKED_REJECTED")
    if (rej.outcome !== "MARKED_REJECTED") return
    assert.equal(rej.attachment.downloadRetryCount, 0)
    assert.equal(rej.attachment.downloadNextRetryAt, null)

    const stored = await createAttachment(companyA, messageA, `stored-${Date.now()}`, {
      status: "STORED",
      sha256: "abc",
      storagePublicId: "pid",
      storageUrl: "https://example.invalid/x",
      storedAt: new Date(),
    })
    const againstStored = await repo.markFailure(companyA, stored.id, {
      status: "FAILED",
      errorCode: "ATTACHMENT_STORAGE_FAILED",
      failedAt: new Date(),
    })
    assert.equal(againstStored.outcome, "STATE_CHANGED")
    const storedRow = await db.acquisitionAttachment.findFirstOrThrow({ where: { id: stored.id } })
    assert.equal(storedRow.status, "STORED")
  })

  it("FAILED éligible → DISCOVERED ; double retry un gagnant", async () => {
    const att = await createAttachment(companyA, messageA, `retry-${Date.now()}`, {
      status: "FAILED",
      lastErrorCode: "GMAIL_NOT_CONNECTED",
      downloadRetryCount: 1,
      downloadNextRetryAt: new Date(Date.now() - 1000),
    })
    const now = new Date()
    const codes = [...RETRYABLE_ATTACHMENT_ERROR_CODES]
    const [x, y] = await Promise.all([
      repo.scheduleRetryToDiscovered({
        companyId: companyA,
        attachmentId: att.id,
        now,
        maxRetries: 5,
        retryableErrorCodes: codes,
      }),
      repo.scheduleRetryToDiscovered({
        companyId: companyA,
        attachmentId: att.id,
        now,
        maxRetries: 5,
        retryableErrorCodes: codes,
      }),
    ])
    assert.equal([x, y].filter((v) => v === "TRANSITIONED").length, 1)
    const row = await db.acquisitionAttachment.findFirstOrThrow({ where: { id: att.id } })
    assert.equal(row.status, "DISCOVERED")
    assert.equal(row.downloadNextRetryAt, null)
    assert.equal(row.downloadRetryCount, 1)
    assert.equal(row.lastErrorCode, "GMAIL_NOT_CONNECTED")
  })

  it("isolation multi-tenant + listing 004C après retry", async () => {
    const attB = await createAttachment(companyB, messageB, `iso-${Date.now()}`, {
      status: "FAILED",
      lastErrorCode: "ATTACHMENT_STORAGE_FAILED",
      downloadRetryCount: 1,
      downloadNextRetryAt: new Date(Date.now() - 1000),
    })
    await repo.scheduleRetryToDiscovered({
      companyId: companyA,
      attachmentId: attB.id,
      now: new Date(),
      maxRetries: 5,
      retryableErrorCodes: [...RETRYABLE_ATTACHMENT_ERROR_CODES],
    })
    const stillFailed = await db.acquisitionAttachment.findFirstOrThrow({ where: { id: attB.id } })
    assert.equal(stillFailed.status, "FAILED")

    await repo.scheduleRetryToDiscovered({
      companyId: companyB,
      attachmentId: attB.id,
      now: new Date(),
      maxRetries: 5,
      retryableErrorCodes: [...RETRYABLE_ATTACHMENT_ERROR_CODES],
    })
    const listed = await repo.listDiscoveredAttachmentsForCompany({
      companyId: companyB,
      limit: 50,
    })
    assert.ok(listed.some((r) => r.id === attB.id))
  })

  it("après reclaim, claim 004 fonctionne", async () => {
    const att = await createAttachment(companyA, messageA, `reclaim-claim-${Date.now()}`, {
      status: "PENDING_DOWNLOAD",
      downloadClaimedAt: new Date(Date.now() - 60 * 60_000),
    })
    assert.equal(
      await repo.reclaimPendingDownload({
        companyId: companyA,
        attachmentId: att.id,
        olderThan: new Date(Date.now() - 30 * 60_000),
      }),
      "RECLAIMED"
    )
    const claim = await repo.claimForDownload(companyA, att.id)
    assert.equal(claim.status, "CLAIMED")
  })

  it("code non retryable / nextRetryAt futur → NOOP schedule", async () => {
    const forbidden = await createAttachment(companyA, messageA, `nr-${Date.now()}`, {
      status: "FAILED",
      lastErrorCode: "GMAIL_ATTACHMENT_NOT_FOUND",
      downloadRetryCount: 1,
      downloadNextRetryAt: new Date(Date.now() - 1000),
    })
    assert.equal(
      await repo.scheduleRetryToDiscovered({
        companyId: companyA,
        attachmentId: forbidden.id,
        now: new Date(),
        maxRetries: 5,
        retryableErrorCodes: [...RETRYABLE_ATTACHMENT_ERROR_CODES],
      }),
      "NOOP"
    )

    const future = await createAttachment(companyA, messageA, `fut-${Date.now()}`, {
      status: "FAILED",
      lastErrorCode: "GMAIL_NOT_CONNECTED",
      downloadRetryCount: 1,
      downloadNextRetryAt: new Date(Date.now() + 60 * 60_000),
    })
    assert.equal(
      await repo.scheduleRetryToDiscovered({
        companyId: companyA,
        attachmentId: future.id,
        now: new Date(),
        maxRetries: 5,
        retryableErrorCodes: [...RETRYABLE_ATTACHMENT_ERROR_CODES],
      }),
      "NOOP"
    )
  })
})
