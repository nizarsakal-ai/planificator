/**
 * Exemption TARGET-ONLY du gate conversion — preuves PostgreSQL RÉELLES (gates globaux OFF).
 * Rollback intégral, claim conflict sans retry, fence NOT_OWNED, concurrence → un seul Worksite.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent (même infrastructure que conversion-tx-fence.pg).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
delete process.env.ACQUISITION_CONVERSION_ENABLED

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { seedLauraluPartnerForCompany } from "./helpers/seed-lauralu-partner"
import { ImportDraftConversionService } from "@/lib/acquisition/conversion/conversion.service"
import { createTestOrchestratorLeaseTransactionalFence } from "./helpers/orchestrator-lease-tx-fence"
import { PrismaAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import { targetedConversionMasterGateExemption } from "@/lib/acquisition/orchestrator/targeted-staging-worksite-creation-selection"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)
const RUN = {
  skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini",
}

describe("TARGETED — PostgreSQL gate conversion OFF + exemption ciblée", RUN, () => {
  const stamp = Date.now()
  const leaseKey = `${ACQUISITION_ORCHESTRATOR_LEASE_KEY}-tconv-${stamp}`
  let companyId = ""
  let draftId = ""
  let clientId = ""
  let dbA: PrismaClient
  let dbB: PrismaClient
  let repoA: PrismaAcquisitionOrchestratorLeaseRepository

  const noGeocode = { geocodeAddress: async () => null }

  before(async () => {
    dbA = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    dbB = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    repoA = new PrismaAcquisitionOrchestratorLeaseRepository(dbA)

    const company = await dbA.company.create({
      data: { name: "Targeted Conv Co", slug: `tconv-${stamp}` },
    })
    companyId = company.id
    await seedLauraluPartnerForCompany(dbA, companyId)
    await dbA.user.create({
      data: {
        email: `sys-tconv-${stamp}@test.local`,
        name: "Sys TConv",
        role: "ADMIN",
        companyId,
        password: "hashed-not-used",
      },
    })
    const client = await dbA.client.create({
      data: { name: "Client TConv", companyId, email: "c@test.fr" },
    })
    clientId = client.id

    const reg = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-tconv-${stamp}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Targeted convert",
        receivedAt: new Date(),
        attachments: [],
      },
      dbA
    )
    assert.ok(reg.draftId)
    draftId = reg.draftId!

    await dbA.$executeRaw`
      INSERT INTO "acquisition_orchestrator_leases" ("key", "ownerRunId", "leaseExpiresAt", "acquiredAt", "updatedAt")
      VALUES (${leaseKey}, NULL, NULL, NULL, clock_timestamp())
      ON CONFLICT ("key") DO NOTHING
    `
    // Cible serveur autorisée = draft seedé ; gates globaux restent OFF.
    process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = companyId
    process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = draftId
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
    await dbA.worksiteImportDraft.updateMany({ where: { companyId }, data: { createdWorksiteId: null } })
    if (worksiteIds.length) {
      await dbA.document.deleteMany({ where: { worksiteId: { in: worksiteIds } } })
    }
    await dbA.worksite.deleteMany({ where: { companyId } })
    await dbA.worksiteImportDraft.deleteMany({ where: { companyId } })
    await dbA.acquisitionAttachment.deleteMany({ where: { companyId } }).catch(() => undefined)
    await dbA.acquisitionMessage.deleteMany({ where: { companyId } })
    await dbA.acquisitionPartnerDomain.deleteMany({ where: { companyId } })
    await dbA.acquisitionPartner.deleteMany({ where: { companyId } })
    await dbA.client.deleteMany({ where: { companyId } })
    await dbA.user.deleteMany({ where: { companyId } })
    await dbA.$executeRaw`DELETE FROM "acquisition_orchestrator_leases" WHERE "key" = ${leaseKey}`
    await dbA.company.delete({ where: { id: companyId } }).catch(() => undefined)
    delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID
    delete process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID
    await dbA.$disconnect()
    await dbB.$disconnect()
  })

  async function resetApproved() {
    await dbA.worksiteImportDraft.update({
      where: { id: draftId },
      data: {
        status: "APPROVED",
        version: 6,
        createdWorksiteId: null,
        proposedWorksiteName: "Chantier ciblé",
        proposedAddress: "10 rue Cible",
        proposedPostalCode: "69001",
        proposedCity: "Lyon",
        proposedStartDate: new Date("2026-09-11"),
        proposedEndDate: null,
        proposedClientId: clientId,
        contentHashAtExtraction: "h-tconv",
        extractionSchemaVersion: "3",
      },
    })
    await dbA.worksite.deleteMany({ where: { companyId } })
    await dbA.$executeRaw`
      UPDATE "acquisition_orchestrator_leases"
      SET "ownerRunId" = NULL, "leaseExpiresAt" = NULL, "acquiredAt" = NULL
      WHERE "key" = ${leaseKey}
    `
  }

  async function owned(runId: string) {
    const acq = await repoA.acquire({ key: leaseKey, ownerRunId: runId, leaseTtlMs: 60_000 })
    assert.equal(acq.outcome, "ACQUIRED")
    return createTestOrchestratorLeaseTransactionalFence({ leaseKey, ownerRunId: runId })
  }

  const SYSTEM = () => ({ actorUserId: "sys1", actorRole: "SYSTEM" as const, companyId })
  const input = (expectedVersion = 6) => ({
    draftId,
    expectedVersion,
    clientMode: "EXISTING" as const,
    existingClientId: clientId,
  })

  async function state() {
    const d = await dbA.worksiteImportDraft.findUniqueOrThrow({ where: { id: draftId } })
    return {
      status: d.status,
      version: d.version,
      createdWorksiteId: d.createdWorksiteId,
      worksites: await dbA.worksite.count({ where: { companyId } }),
    }
  }

  it("T-1 — gates OFF, sans exemption → CONVERSION_DISABLED, zéro mutation", async () => {
    await resetApproved()
    const fence = await owned("run-t1")
    const svc = new ImportDraftConversionService({ db: dbA, geocode: noGeocode })
    const r = await svc.convertImportDraft(SYSTEM(), input(), { transactionalOwnershipFence: fence })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "CONVERSION_DISABLED")
    assert.deepEqual(await state(), { status: "APPROVED", version: 6, createdWorksiteId: null, worksites: 0 })
  })

  it("T-2 — gates OFF + exemption + fence OWNED → CONVERTED, un Worksite, version +1", async () => {
    await resetApproved()
    const fence = await owned("run-t2")
    const svc = new ImportDraftConversionService({ db: dbA, geocode: noGeocode })
    const r = await svc.convertImportDraft(SYSTEM(), input(), {
      transactionalOwnershipFence: fence,
      conversionMasterGateExemption: targetedConversionMasterGateExemption,
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    if (r.ok) assert.equal(r.outcome, "CONVERTED")
    const s = await state()
    assert.equal(s.status, "CONVERTED")
    assert.equal(s.version, 7)
    assert.ok(s.createdWorksiteId)
    assert.equal(s.worksites, 1)
    assert.equal(process.env.PLANIFICATOR_ACQUISITION_ENABLED, undefined)
    assert.equal(process.env.ACQUISITION_CONVERSION_ENABLED, undefined)
  })

  it("T-3 — exemption + fence NOT_OWNED (lease d'un autre run) → LEASE_NOT_OWNED, zéro mutation", async () => {
    await resetApproved()
    await owned("run-t3-real-owner")
    const staleFence = createTestOrchestratorLeaseTransactionalFence({ leaseKey, ownerRunId: "run-t3-stale" })
    const svc = new ImportDraftConversionService({ db: dbA, geocode: noGeocode })
    const r = await svc.convertImportDraft(SYSTEM(), input(), {
      transactionalOwnershipFence: staleFence,
      conversionMasterGateExemption: targetedConversionMasterGateExemption,
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "LEASE_NOT_OWNED")
    assert.deepEqual(await state(), { status: "APPROVED", version: 6, createdWorksiteId: null, worksites: 0 })
  })

  it("T-4 — claim conflict (expectedVersion obsolète) → STATE_CHANGED, rollback, un seul appel", async () => {
    await resetApproved()
    const fence = await owned("run-t4")
    const svc = new ImportDraftConversionService({ db: dbA, geocode: noGeocode })
    const r = await svc.convertImportDraft(SYSTEM(), input(5), {
      transactionalOwnershipFence: fence,
      conversionMasterGateExemption: targetedConversionMasterGateExemption,
    })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "STATE_CHANGED")
    assert.deepEqual(await state(), { status: "APPROVED", version: 6, createdWorksiteId: null, worksites: 0 })
  })

  it("T-5 — échec après worksite.create dans la TX → rollback intégral (aucun Worksite, draft APPROVED)", async () => {
    await resetApproved()
    const fence = await owned("run-t5")
    const failingDb = new Proxy(dbA, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver)
        return async <T>(fn: (tx: import("@prisma/client").Prisma.TransactionClient) => Promise<T>): Promise<T> =>
          target.$transaction(async (tx) => {
            const proxied = new Proxy(tx, {
              get(txTarget, txProp, txReceiver) {
                if (txProp === "worksite") {
                  return new Proxy(txTarget.worksite, {
                    get(ws, wsProp, wsReceiver) {
                      if (wsProp === "create") {
                        return async (...args: unknown[]) => {
                          await (txTarget.worksite.create as (...a: unknown[]) => Promise<unknown>)(...args)
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
    const svc = new ImportDraftConversionService({ db: failingDb as PrismaClient, geocode: noGeocode })
    const r = await svc.convertImportDraft(SYSTEM(), input(), {
      transactionalOwnershipFence: fence,
      conversionMasterGateExemption: targetedConversionMasterGateExemption,
    })
    assert.equal(r.ok, false)
    assert.deepEqual(await state(), { status: "APPROVED", version: 6, createdWorksiteId: null, worksites: 0 })
  })

  it("T-6 — deux conversions concurrentes (clients distincts) → un seul Worksite persistant", async () => {
    await resetApproved()
    const fence = await owned("run-t6")
    const svcA = new ImportDraftConversionService({ db: dbA, geocode: noGeocode })
    const svcB = new ImportDraftConversionService({ db: dbB, geocode: noGeocode })
    const opts = {
      transactionalOwnershipFence: fence,
      conversionMasterGateExemption: targetedConversionMasterGateExemption,
    }
    const [a, b] = await Promise.all([
      svcA.convertImportDraft(SYSTEM(), input(), opts),
      svcB.convertImportDraft(SYSTEM(), input(), opts),
    ])
    const converted = [a, b].filter((r) => r.ok && r.outcome === "CONVERTED")
    assert.equal(converted.length, 1, JSON.stringify([a, b]))
    const other = [a, b].find((r) => !(r.ok && r.outcome === "CONVERTED"))!
    assert.ok(
      (other.ok && other.outcome === "ALREADY_CONVERTED") ||
        (!other.ok && ["INVALID_STATE", "STATE_CHANGED"].includes(other.code)),
      JSON.stringify(other)
    )
    const s = await state()
    assert.equal(s.status, "CONVERTED")
    assert.equal(s.version, 7)
    assert.equal(s.worksites, 1)
  })

  it("T-7 — mauvaise cible serveur → CONVERSION_DISABLED malgré fence OWNED, zéro mutation", async () => {
    await resetApproved()
    const fence = await owned("run-t7")
    const saved = process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID
    process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = "draft-other"
    try {
      const svc = new ImportDraftConversionService({ db: dbA, geocode: noGeocode })
      const r = await svc.convertImportDraft(SYSTEM(), input(), {
        transactionalOwnershipFence: fence,
        conversionMasterGateExemption: targetedConversionMasterGateExemption,
      })
      assert.equal(r.ok, false)
      if (!r.ok) assert.equal(r.code, "CONVERSION_DISABLED")
    } finally {
      process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = saved
    }
    assert.deepEqual(await state(), { status: "APPROVED", version: 6, createdWorksiteId: null, worksites: 0 })
  })
})
