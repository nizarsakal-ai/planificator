/**
 * PLAN-ACQ-AGENTS-LOT-3G — Preuves PG fence TX (approve / reject / cancellation).
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.PLANIFICATOR_ACQUISITION_ENABLED ??= "true"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { seedLauraluPartnerForCompany } from "./helpers/seed-lauralu-partner"
import { ImportDraftReviewService } from "@/lib/acquisition/review/import-draft-review.service"
import {
  applyCancellationFollowUpTransactionally,
  CancellationLeaseNotOwnedError,
} from "@/lib/acquisition/policy/cancellation-followup"
import { createTestOrchestratorLeaseTransactionalFence } from "./helpers/orchestrator-lease-tx-fence"
import { PrismaAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)
const RUN = {
  skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini",
}

describe("LOT-3G — PostgreSQL review/cancellation transactional fence", RUN, () => {
  const stamp = Date.now()
  const leaseKey = `${ACQUISITION_ORCHESTRATOR_LEASE_KEY}-3g-${stamp}`
  let companyId = ""
  let draftId = ""
  let systemUserId = ""
  let dbA: PrismaClient
  let dbB: PrismaClient
  let repoA: PrismaAcquisitionOrchestratorLeaseRepository
  let repoB: PrismaAcquisitionOrchestratorLeaseRepository

  before(async () => {
    dbA = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    dbB = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    repoA = new PrismaAcquisitionOrchestratorLeaseRepository(dbA)
    repoB = new PrismaAcquisitionOrchestratorLeaseRepository(dbB)
    const company = await dbA.company.create({
      data: { name: "3G Fence Co", slug: `lot3g-${stamp}` },
    })
    companyId = company.id
    await seedLauraluPartnerForCompany(dbA, companyId)
    const user = await dbA.user.create({
      data: {
        email: `sys-3g-${stamp}@test.local`,
        name: "Sys 3G",
        role: "ADMIN",
        companyId,
        password: "hashed-not-used",
      },
    })
    systemUserId = user.id
    const reg = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-3g-${stamp}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "3G approve",
        receivedAt: new Date(),
        attachments: [],
      },
      dbA
    )
    assert.ok(reg.draftId)
    draftId = reg.draftId!
    await dbA.worksiteImportDraft.update({
      where: { id: draftId },
      data: {
        status: "PENDING_REVIEW",
        version: 1,
        proposedWorksiteName: "Chantier 3G",
        proposedStartDate: new Date("2026-11-01"),
        proposedEndDate: new Date("2026-11-03"),
        contentHashAtExtraction: "h3g",
        extractionSchemaVersion: "2",
      },
    })
    await dbA.$executeRaw`
      INSERT INTO "acquisition_orchestrator_leases" ("key", "ownerRunId", "leaseExpiresAt", "acquiredAt", "updatedAt")
      VALUES (${leaseKey}, NULL, NULL, NULL, clock_timestamp())
      ON CONFLICT ("key") DO NOTHING
    `
  })

  after(async () => {
    if (!enabled) return
    await dbA.worksiteImportDraft.deleteMany({ where: { companyId } })
    await dbA.acquisitionMessage.deleteMany({ where: { companyId } })
    await dbA.acquisitionPartnerDomain.deleteMany({ where: { companyId } })
    await dbA.acquisitionPartner.deleteMany({ where: { companyId } })
    await dbA.user.deleteMany({ where: { companyId } })
    await dbA.$executeRaw`DELETE FROM "acquisition_orchestrator_leases" WHERE "key" = ${leaseKey}`
    await dbA.company.delete({ where: { id: companyId } }).catch(() => undefined)
    await dbA.$disconnect()
    await dbB.$disconnect()
  })

  it("B — SYSTEM approve OWNED → APPROVED ; stale fence → zéro mutation", async () => {
    await dbA.$executeRaw`
      UPDATE "acquisition_orchestrator_leases"
      SET "ownerRunId" = NULL, "leaseExpiresAt" = NULL, "acquiredAt" = NULL
      WHERE "key" = ${leaseKey}
    `
    await dbA.worksiteImportDraft.update({
      where: { id: draftId },
      data: { status: "PENDING_REVIEW", version: 1 },
    })
    const acq = await repoA.acquire({
      key: leaseKey,
      ownerRunId: "run-a",
      leaseTtlMs: 60_000,
    })
    assert.equal(acq.outcome, "ACQUIRED")
    const fence = createTestOrchestratorLeaseTransactionalFence({
      leaseKey,
      ownerRunId: "run-a",
    })
    const svc = new ImportDraftReviewService({ db: dbA })
    const ok = await svc.approveImportDraft(
      { actorUserId: systemUserId, actorRole: "SYSTEM", companyId },
      { draftId, expectedVersion: 1 },
      { transactionalOwnershipFence: fence }
    )
    assert.equal(ok.ok, true)
    const draft = await dbA.worksiteImportDraft.findUniqueOrThrow({
      where: { id: draftId },
    })
    assert.equal(draft.status, "APPROVED")

    await dbA.worksiteImportDraft.update({
      where: { id: draftId },
      data: { status: "PENDING_REVIEW", version: 3 },
    })
    const stale = createTestOrchestratorLeaseTransactionalFence({
      leaseKey,
      ownerRunId: "run-stale",
    })
    const bad = await svc.approveImportDraft(
      { actorUserId: systemUserId, actorRole: "SYSTEM", companyId },
      { draftId, expectedVersion: 3 },
      { transactionalOwnershipFence: stale }
    )
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.equal(bad.code, "LEASE_NOT_OWNED")
    const again = await dbA.worksiteImportDraft.findUniqueOrThrow({
      where: { id: draftId },
    })
    assert.equal(again.status, "PENDING_REVIEW")
    await repoA.release({ key: leaseKey, ownerRunId: "run-a" })
  })

  it("C — SYSTEM reject OWNED ; F — ADMIN sans lease OK", async () => {
    await dbA.$executeRaw`
      UPDATE "acquisition_orchestrator_leases"
      SET "ownerRunId" = NULL, "leaseExpiresAt" = NULL, "acquiredAt" = NULL
      WHERE "key" = ${leaseKey}
    `
    await dbA.worksiteImportDraft.update({
      where: { id: draftId },
      data: { status: "PENDING_REVIEW", version: 5 },
    })
    const acq = await repoA.acquire({
      key: leaseKey,
      ownerRunId: "run-r",
      leaseTtlMs: 60_000,
    })
    assert.equal(acq.outcome, "ACQUIRED")
    const fence = createTestOrchestratorLeaseTransactionalFence({
      leaseKey,
      ownerRunId: "run-r",
    })
    const svc = new ImportDraftReviewService({ db: dbA })
    const r = await svc.rejectImportDraft(
      { actorUserId: systemUserId, actorRole: "SYSTEM", companyId },
      {
        draftId,
        expectedVersion: 5,
        rejectionReason: "Annulation automatique client",
      },
      { transactionalOwnershipFence: fence }
    )
    assert.equal(r.ok, true)
    await repoA.release({ key: leaseKey, ownerRunId: "run-r" })

    await dbA.worksiteImportDraft.update({
      where: { id: draftId },
      data: { status: "PENDING_REVIEW", version: 7 },
    })
    const admin = await svc.approveImportDraft(
      { actorUserId: systemUserId, actorRole: "ADMIN", companyId },
      { draftId, expectedVersion: 7 }
    )
    assert.equal(admin.ok, true)
  })

  it("D — cancellation NOT_OWNED → 0 mutation + 0 journal", async () => {
    const msg = await dbA.acquisitionMessage.findFirstOrThrow({
      where: { companyId },
    })
    await dbA.acquisitionMessage.update({
      where: { id: msg.id },
      data: { threadId: `th-3g-${stamp}` },
    })
    await dbA.worksiteImportDraft.update({
      where: { id: draftId },
      data: {
        status: "REJECTED",
        rejectionReason: "CANCELLED_INITIAL",
        version: 10,
      },
    })
    const reg2 = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-3g-tgt-${stamp}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "target",
        receivedAt: new Date(),
        attachments: [],
      },
      dbA
    )
    assert.ok(reg2.draftId)
    await dbA.acquisitionMessage.update({
      where: { id: reg2.messageId },
      data: { threadId: `th-3g-${stamp}` },
    })
    await dbA.worksiteImportDraft.update({
      where: { id: reg2.draftId! },
      data: { status: "PENDING_REVIEW", version: 1 },
    })

    await dbA.$executeRaw`
      UPDATE "acquisition_orchestrator_leases"
      SET "ownerRunId" = NULL, "leaseExpiresAt" = NULL, "acquiredAt" = NULL
      WHERE "key" = ${leaseKey}
    `
    const staleFence = createTestOrchestratorLeaseTransactionalFence({
      leaseKey,
      ownerRunId: "not-owner",
    })
    await assert.rejects(
      () =>
        applyCancellationFollowUpTransactionally({
          companyId,
          sourceDraftId: draftId,
          threadId: `th-3g-${stamp}`,
          frozen: {
            contentHash: "h3g",
            extractionSchemaVersion: "2",
            validatedDraftVersion: 10,
          },
          actorUserId: null,
          db: dbA,
          transactionalOwnershipFence: staleFence,
        }),
      (e: unknown) => e instanceof CancellationLeaseNotOwnedError
    )
    const tgt = await dbA.worksiteImportDraft.findUniqueOrThrow({
      where: { id: reg2.draftId! },
    })
    assert.equal(tgt.status, "PENDING_REVIEW")
    const journals = await dbA.acquisitionDecisionJournal.count({
      where: { companyId, draftId },
    })
    assert.equal(journals, 0)
  })

  it("E — takeover bloqué sous FOR UPDATE puis ACQUIRED après expire+release", async () => {
    await dbA.$executeRaw`
      UPDATE "acquisition_orchestrator_leases"
      SET "ownerRunId" = NULL, "leaseExpiresAt" = NULL, "acquiredAt" = NULL
      WHERE "key" = ${leaseKey}
    `
    const acq = await repoA.acquire({
      key: leaseKey,
      ownerRunId: "hold-a",
      leaseTtlMs: 800,
    })
    assert.equal(acq.outcome, "ACQUIRED")
    let held = false
    let release!: () => void
    const hold = new Promise<void>((r) => {
      release = r
    })
    const fence = createTestOrchestratorLeaseTransactionalFence({
      leaseKey,
      ownerRunId: "hold-a",
    })
    const aTx = dbA.$transaction(
      async (tx) => {
        assert.equal(await fence.assertOwnedAndLock(tx), "OWNED")
        held = true
        await hold
        return "done"
      },
      { timeout: 30_000 }
    )
    for (let i = 0; i < 200 && !held; i++) await new Promise((r) => setTimeout(r, 5))
    assert.equal(held, true)
    for (let i = 0; i < 40; i++) {
      const exp = await dbB.$queryRaw<Array<{ expired: boolean }>>`
        SELECT ("leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" < clock_timestamp()) AS expired
        FROM "acquisition_orchestrator_leases" WHERE "key" = ${leaseKey}
      `
      if (exp[0]?.expired) break
      await new Promise((r) => setTimeout(r, 50))
    }
    let bDone = false
    let bOutcome: string | null = null
    const bP = repoB
      .acquire({ key: leaseKey, ownerRunId: "hold-b", leaseTtlMs: 60_000 })
      .then((r) => {
        bDone = true
        bOutcome = r.outcome
        return r
      })
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(bDone, false)
    release()
    await aTx
    await bP
    assert.equal(bOutcome, "ACQUIRED")
    await repoB.release({ key: leaseKey, ownerRunId: "hold-b" })
  })
})
