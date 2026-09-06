/**
 * PLAN-ACQ-AGENTS-LOT-3F — Preuve PostgreSQL fence TX + row lock lease.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.PLANIFICATOR_ACQUISITION_ENABLED ??= "true"
process.env.ACQUISITION_CONVERSION_ENABLED ??= "true"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { seedLauraluPartnerForCompany } from "./helpers/seed-lauralu-partner"
import { ImportDraftConversionService } from "@/lib/acquisition/conversion/conversion.service"
import { createTestOrchestratorLeaseTransactionalFence } from "./helpers/orchestrator-lease-tx-fence"
import { PrismaAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)
const RUN = {
  skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini",
}

describe("LOT-3F — PostgreSQL conversion transactional lease fence", RUN, () => {
  const stamp = Date.now()
  const leaseKey = `${ACQUISITION_ORCHESTRATOR_LEASE_KEY}-3f-${stamp}`
  let companyId = ""
  let draftId = ""
  let clientId = ""
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
      data: { name: "3F Fence Co", slug: `lot3f-${stamp}` },
    })
    companyId = company.id
    await seedLauraluPartnerForCompany(dbA, companyId)

    await dbA.user.create({
      data: {
        email: `sys-3f-${stamp}@test.local`,
        name: "Sys 3F",
        role: "ADMIN",
        companyId,
        password: "hashed-not-used",
      },
    })
    const client = await dbA.client.create({
      data: { name: "Client 3F", companyId, email: "c@test.fr" },
    })
    clientId = client.id

    const reg = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-3f-${stamp}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "3F convert",
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
        status: "APPROVED",
        version: 2,
        proposedWorksiteName: "Chantier 3F",
        proposedAddress: "10 rue Fence",
        proposedPostalCode: "69001",
        proposedCity: "Lyon",
        proposedStartDate: new Date("2026-10-01"),
        proposedEndDate: new Date("2026-10-03"),
        proposedClientId: clientId,
        contentHashAtExtraction: "h3f",
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
    const drafts = await dbA.worksiteImportDraft.findMany({
      where: { companyId },
      select: { createdWorksiteId: true },
    })
    const worksiteIds = drafts
      .map((d) => d.createdWorksiteId)
      .filter((id): id is string => Boolean(id))
    if (worksiteIds.length) {
      await dbA.document.deleteMany({ where: { worksiteId: { in: worksiteIds } } })
      await dbA.worksiteImportDraft.updateMany({
        where: { companyId },
        data: { createdWorksiteId: null },
      })
      await dbA.worksite.deleteMany({ where: { id: { in: worksiteIds } } })
    }
    await dbA.worksiteImportDraft.deleteMany({ where: { companyId } })
    await dbA.acquisitionAttachment.deleteMany({ where: { companyId } }).catch(() => undefined)
    await dbA.acquisitionMessage.deleteMany({ where: { companyId } })
    await dbA.acquisitionPartnerDomain.deleteMany({ where: { companyId } })
    await dbA.acquisitionPartner.deleteMany({ where: { companyId } })
    await dbA.client.deleteMany({ where: { companyId } })
    await dbA.user.deleteMany({ where: { companyId } })
    await dbA.$executeRaw`DELETE FROM "acquisition_orchestrator_leases" WHERE "key" = ${leaseKey}`
    await dbA.company.delete({ where: { id: companyId } }).catch(() => undefined)
    await dbA.$disconnect()
    await dbB.$disconnect()
  })

  async function resetDraftApproved() {
    await dbA.worksiteImportDraft.update({
      where: { id: draftId },
      data: {
        status: "APPROVED",
        version: 2,
        createdWorksiteId: null,
      },
    })
    await dbA.worksite.deleteMany({ where: { companyId } })
  }

  it("PG-A — OWNED : fence + conversion COMMIT → CONVERTED", async () => {
    await resetDraftApproved()
    await repoA.release({ key: leaseKey, ownerRunId: "run-a" }).catch(() => undefined)
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
    const svc = new ImportDraftConversionService({
      db: dbA,
      geocode: { geocodeAddress: async () => null },
    })
    const r = await svc.convertImportDraft(
      { actorUserId: "sys1", actorRole: "SYSTEM", companyId },
      {
        draftId,
        expectedVersion: 2,
        clientMode: "EXISTING",
        existingClientId: clientId,
      },
      { transactionalOwnershipFence: fence }
    )
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.outcome, "CONVERTED")
    const draft = await dbA.worksiteImportDraft.findUniqueOrThrow({
      where: { id: draftId },
    })
    assert.equal(draft.status, "CONVERTED")
    await repoA.release({ key: leaseKey, ownerRunId: "run-a" })
  })

  it("PG-B — STALE OWNER : fence NOT_OWNED → zéro mutation", async () => {
    await resetDraftApproved()
    await repoA.acquire({
      key: leaseKey,
      ownerRunId: "run-b-owner",
      leaseTtlMs: 60_000,
    })

    const fence = createTestOrchestratorLeaseTransactionalFence({
      leaseKey,
      ownerRunId: "run-stale-a",
    })
    const svc = new ImportDraftConversionService({ db: dbA })
    const r = await svc.convertImportDraft(
      { actorUserId: "sys1", actorRole: "SYSTEM", companyId },
      {
        draftId,
        expectedVersion: 2,
        clientMode: "EXISTING",
        existingClientId: clientId,
      },
      { transactionalOwnershipFence: fence }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.outcome, "LEASE_NOT_OWNED")
    const draft = await dbA.worksiteImportDraft.findUniqueOrThrow({
      where: { id: draftId },
    })
    assert.equal(draft.status, "APPROVED")
    assert.equal(draft.createdWorksiteId, null)
    const ws = await dbA.worksite.count({ where: { companyId } })
    assert.equal(ws, 0)
    await repoA.release({ key: leaseKey, ownerRunId: "run-b-owner" })
  })

  it("PG-C — takeover bloqué pendant FOR UPDATE (barrière)", async () => {
    await repoA.release({ key: leaseKey, ownerRunId: "run-hold-a" }).catch(() => undefined)
    // TTL courte : après expiration, acquire() cible la ligne (UPDATE libre) et
    // DOIT bloquer sur le row lock détenu par la TX conversion A.
    const acq = await repoA.acquire({
      key: leaseKey,
      ownerRunId: "run-hold-a",
      leaseTtlMs: 700,
    })
    assert.equal(acq.outcome, "ACQUIRED")

    let aHoldsRowLock = false
    let releaseA!: () => void
    const hold = new Promise<void>((resolve) => {
      releaseA = resolve
    })

    const fence = createTestOrchestratorLeaseTransactionalFence({
      leaseKey,
      ownerRunId: "run-hold-a",
    })

    const aTx = dbA.$transaction(
      async (tx) => {
        const state = await fence.assertOwnedAndLock(tx)
        assert.equal(state, "OWNED")
        aHoldsRowLock = true
        await hold
        return "A_DONE"
      },
      { timeout: 30_000, maxWait: 10_000 }
    )

    for (let i = 0; i < 200 && !aHoldsRowLock; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.equal(aHoldsRowLock, true)

    // Preuve indépendante : NOWAIT échoue tant que A détient le lock.
    await assert.rejects(
      () =>
        dbB.$queryRaw`
          SELECT "key"
          FROM "acquisition_orchestrator_leases"
          WHERE "key" = ${leaseKey}
          FOR UPDATE NOWAIT
        `,
      (err: unknown) => {
        const msg = String(err)
        return msg.includes("55P03") || /could not obtain lock/i.test(msg)
      }
    )

    // Attendre l’expiration horloge PG pour que acquire(B) cible réellement la ligne.
    for (let i = 0; i < 40; i++) {
      const expired = await dbB.$queryRaw<Array<{ expired: boolean }>>`
        SELECT (
          "leaseExpiresAt" IS NOT NULL
          AND "leaseExpiresAt" < clock_timestamp()
        ) AS expired
        FROM "acquisition_orchestrator_leases"
        WHERE "key" = ${leaseKey}
      `
      if (expired[0]?.expired) break
      await new Promise((r) => setTimeout(r, 50))
    }

    let bFinished = false
    let bOutcome: string | null = null
    const bStartedAt = Date.now()
    const bPromise = repoB
      .acquire({ key: leaseKey, ownerRunId: "run-hold-b", leaseTtlMs: 60_000 })
      .then((r) => {
        bFinished = true
        bOutcome = r.outcome
        return r
      })

    // Preuve : B reste bloqué sur le row lock (pas un simple ordre chanceux).
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(
      bFinished,
      false,
      "B ne doit pas terminer acquire tant que A détient FOR UPDATE"
    )
    assert.ok(Date.now() - bStartedAt >= 450)

    releaseA()
    assert.equal(await aTx, "A_DONE")
    await bPromise
    assert.equal(bFinished, true)
    // Après release du lock + lease expirée → B peut devenir propriétaire.
    assert.equal(bOutcome, "ACQUIRED")
    await repoB.release({ key: leaseKey, ownerRunId: "run-hold-b" })
  })

  it("PG-D — fence NOT_OWNED + rollback post-mutation forcée : zéro persist", async () => {
    await resetDraftApproved()
    // Pas de lease pour run-d → NOT_OWNED
    await dbA.$executeRaw`
      UPDATE "acquisition_orchestrator_leases"
      SET "ownerRunId" = NULL, "leaseExpiresAt" = NULL, "acquiredAt" = NULL
      WHERE "key" = ${leaseKey}
    `
    const fence = createTestOrchestratorLeaseTransactionalFence({
      leaseKey,
      ownerRunId: "run-d",
    })
    const svc = new ImportDraftConversionService({ db: dbA })
    const r = await svc.convertImportDraft(
      { actorUserId: "sys1", actorRole: "SYSTEM", companyId },
      {
        draftId,
        expectedVersion: 2,
        clientMode: "EXISTING",
        existingClientId: clientId,
      },
      { transactionalOwnershipFence: fence }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "LEASE_NOT_OWNED")
    const draft = await dbA.worksiteImportDraft.findUniqueOrThrow({
      where: { id: draftId },
    })
    assert.equal(draft.status, "APPROVED")
    assert.equal(await dbA.worksite.count({ where: { companyId } }), 0)

    // Rollback après mutation intermédiaire (Proxy test-only, hors production)
    await resetDraftApproved()
    const acq = await repoA.acquire({
      key: leaseKey,
      ownerRunId: "run-d-owned",
      leaseTtlMs: 60_000,
    })
    assert.equal(acq.outcome, "ACQUIRED")
    const ownedFence = createTestOrchestratorLeaseTransactionalFence({
      leaseKey,
      ownerRunId: "run-d-owned",
    })
    const failingDb = new Proxy(dbA, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") {
          return Reflect.get(target, prop, receiver)
        }
        return async <T>(
          fn: (tx: import("@prisma/client").Prisma.TransactionClient) => Promise<T>
        ): Promise<T> =>
          target.$transaction(async (tx) => {
            const proxied = new Proxy(tx, {
              get(txTarget, txProp, txReceiver) {
                if (txProp === "worksite") {
                  return new Proxy(txTarget.worksite, {
                    get(ws, wsProp, wsReceiver) {
                      if (wsProp === "create") {
                        return async (...args: unknown[]) => {
                          await (
                            txTarget.worksite.create as (
                              ...a: unknown[]
                            ) => Promise<unknown>
                          )(...args)
                          throw new Error("FORCED_MID_TX_FAIL")
                        }
                      }
                      return Reflect.get(ws, wsProp, wsReceiver)
                    },
                  })
                }
                return Reflect.get(txTarget, txProp, txReceiver)
              },
            })
            return fn(proxied)
          })
      },
    })
    const svc2 = new ImportDraftConversionService({ db: failingDb as PrismaClient })
    const r2 = await svc2.convertImportDraft(
      { actorUserId: "sys1", actorRole: "SYSTEM", companyId },
      {
        draftId,
        expectedVersion: 2,
        clientMode: "EXISTING",
        existingClientId: clientId,
      },
      { transactionalOwnershipFence: ownedFence }
    )
    assert.equal(r2.ok, false)
    const draft2 = await dbA.worksiteImportDraft.findUniqueOrThrow({
      where: { id: draftId },
    })
    assert.equal(draft2.status, "APPROVED")
    assert.equal(draft2.createdWorksiteId, null)
    assert.equal(await dbA.worksite.count({ where: { companyId } }), 0)
    await repoA.release({ key: leaseKey, ownerRunId: "run-d-owned" })
  })
})
