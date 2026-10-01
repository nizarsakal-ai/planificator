/**
 * Neutralisation des 6 pièces inline historiques — preuves PostgreSQL RÉELLES.
 * Base LOCALE JETABLE uniquement (hôte 127.0.0.1 / localhost exigé). Skip si
 * TEST_ACQUISITION_DATABASE_URL absent (même infrastructure que les autres tests .pg).
 * Seed avec les IDs EXACTS du manifest (requis par le harness), nettoyé en fin de suite.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient, type Prisma } from "@prisma/client"
import {
  INLINE_NEUTRALIZATION_MANIFEST,
  INLINE_NEUTRALIZATION_TARGET,
  runInlineNeutralizationTransaction,
} from "@/lib/acquisition/attachments/targeted-staging-inline-attachment-neutralization.handler"
import { AcquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { ImportDraftConversionService } from "@/lib/acquisition/conversion/conversion.service"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)
const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

const { companyId: COMPANY, acquisitionMessageId: MESSAGE } = INLINE_NEUTRALIZATION_TARGET
const IDS = INLINE_NEUTRALIZATION_MANIFEST.map((e) => e.id)
const OTHER_ID = "pg-inline-other-attachment"
const DRAFT_ID = "pg-inline-draft"
const USER_ID = "pg-inline-user"
const CLIENT_ID = "pg-inline-client"

describe("INLINE NEUTRALIZATION — PostgreSQL réel (base locale jetable)", RUN, () => {
  let dbA: PrismaClient
  let dbB: PrismaClient

  before(async () => {
    const host = new URL(TEST_URL!).hostname
    assert.ok(host === "127.0.0.1" || host === "localhost", "base locale jetable uniquement")
    dbA = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    dbB = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    await cleanup()
    await dbA.company.create({ data: { id: COMPANY, name: "PG Inline Co", slug: `pg-inline-${Date.now()}` } })
    await dbA.user.create({
      data: { id: USER_ID, email: `pg-inline-${Date.now()}@test.local`, name: "PG", role: "ADMIN", companyId: COMPANY, password: "x" },
    })
    await dbA.client.create({ data: { id: CLIENT_ID, name: "Client PG Inline", companyId: COMPANY } })
    await dbA.acquisitionMessage.create({
      data: {
        id: MESSAGE,
        companyId: COMPANY,
        source: "GMAIL",
        externalMessageId: "pg-inline-ext",
        senderEmail: "contact@partner.test",
        senderDomain: "partner.test",
        subject: "PG inline",
        receivedAt: new Date(),
        status: "DRAFT_CREATED",
      },
    })
  })

  after(async () => {
    if (!enabled) return
    await cleanup()
    await dbA.$disconnect()
    await dbB.$disconnect()
  })

  async function cleanup() {
    await dbA.worksiteImportDraft.updateMany({ where: { companyId: COMPANY }, data: { createdWorksiteId: null } })
    const ws = await dbA.worksite.findMany({ where: { companyId: COMPANY }, select: { id: true } })
    if (ws.length) await dbA.document.deleteMany({ where: { worksiteId: { in: ws.map((w) => w.id) } } })
    await dbA.worksite.deleteMany({ where: { companyId: COMPANY } })
    await dbA.worksiteImportDraft.deleteMany({ where: { companyId: COMPANY } })
    await dbA.acquisitionAttachment.deleteMany({ where: { companyId: COMPANY } })
    await dbA.acquisitionMessage.deleteMany({ where: { companyId: COMPANY } })
    await dbA.client.deleteMany({ where: { companyId: COMPANY } })
    await dbA.user.deleteMany({ where: { companyId: COMPANY } })
    await dbA.company.deleteMany({ where: { id: COMPANY } })
  }

  /** 6 lignes historiques DISCOVERED conformes + 1 autre pièce du message (homonyme de filename). */
  async function seedAttachments(over: Record<string, Prisma.AcquisitionAttachmentUncheckedCreateInput> = {}) {
    await dbA.acquisitionAttachment.deleteMany({ where: { companyId: COMPANY } })
    for (const [i, e] of INLINE_NEUTRALIZATION_MANIFEST.entries()) {
      await dbA.acquisitionAttachment.create({
        data: over[e.id] ?? {
          id: e.id,
          companyId: COMPANY,
          acquisitionMessageId: MESSAGE,
          attachmentKey: `ext:INLINE-${i}`,
          externalAttachmentId: `INLINE-${i}`,
          filename: e.filename,
          mimeType: "image/png",
          sizeBytes: e.sizeBytes,
          category: "PHOTO",
          status: "DISCOVERED",
        },
      })
    }
    await dbA.acquisitionAttachment.create({
      data: {
        id: OTHER_ID,
        companyId: COMPANY,
        acquisitionMessageId: MESSAGE,
        attachmentKey: "ext:OTHER",
        externalAttachmentId: "OTHER",
        filename: "image006.png",
        mimeType: "image/png",
        sizeBytes: 230197,
        category: "PHOTO",
        status: "DISCOVERED",
      },
    })
  }

  async function snapshot() {
    return dbA.acquisitionAttachment.findMany({ where: { companyId: COMPANY }, orderBy: { id: "asc" } })
  }

  beforeEach(async () => {
    if (enabled) await seedAttachments()
  })

  it("P-1 — RUN valide → exactement 6 REJECTED/INLINE_MIME_EMBEDDED, autres champs inchangés, autre pièce intacte", async () => {
    const before = await snapshot()
    const now = new Date()
    const out = await runInlineNeutralizationTransaction(dbA, now)
    assert.deepEqual(out, { outcome: "NEUTRALIZED", updated: 6 })
    const after = await snapshot()
    for (const b of before) {
      const a = after.find((x) => x.id === b.id)!
      if (IDS.includes(b.id)) {
        assert.equal(a.status, "REJECTED")
        assert.equal(a.lastErrorCode, "INLINE_MIME_EMBEDDED")
        assert.equal(a.lastErrorAt?.getTime(), now.getTime())
        const { status: _s, lastErrorCode: _c, lastErrorAt: _a, updatedAt: _u, ...restA } = a
        const { status: _s2, lastErrorCode: _c2, lastErrorAt: _a2, updatedAt: _u2, ...restB } = b
        assert.deepEqual(restA, restB)
      } else {
        assert.deepEqual(a, b, "autre pièce du message totalement intacte (y compris updatedAt)")
      }
    }
  })

  it("P-2 — second RUN → ALREADY_NEUTRALIZED, zéro écriture (updatedAt inchangés)", async () => {
    assert.equal((await runInlineNeutralizationTransaction(dbA, new Date())).outcome, "NEUTRALIZED")
    const before = await snapshot()
    const out = await runInlineNeutralizationTransaction(dbA, new Date(Date.now() + 60_000))
    assert.deepEqual(out, { outcome: "ALREADY_NEUTRALIZED" })
    assert.deepEqual(await snapshot(), before)
  })

  it("P-3 — préconditions KO (5/6, status, sha256) → PRECONDITION_FAILED, zéro écriture", async () => {
    const scenarios: Array<() => Promise<void>> = [
      async () => { await dbA.acquisitionAttachment.delete({ where: { id: IDS[5]! } }) },
      async () => { await dbA.acquisitionAttachment.update({ where: { id: IDS[2]! }, data: { status: "PENDING_DOWNLOAD", downloadClaimedAt: new Date() } }) },
      async () => { await dbA.acquisitionAttachment.update({ where: { id: IDS[0]! }, data: { sha256: "abc" } }) },
      async () => { await dbA.acquisitionAttachment.update({ where: { id: IDS[1]! }, data: { sizeBytes: 1 } }) },
    ]
    for (const mutate of scenarios) {
      await seedAttachments()
      await mutate()
      const before = await snapshot()
      const out = await runInlineNeutralizationTransaction(dbA, new Date())
      assert.equal(out.outcome, "PRECONDITION_FAILED")
      assert.deepEqual(await snapshot(), before)
    }
  })

  /** Proxy : opérations réelles dans la TX réelle, puis altération ciblée → prouve le rollback PostgreSQL. */
  function withTxHook(hook: { updateCount?: number; tamperSecondFindMany?: boolean }): PrismaClient {
    return new Proxy(dbA, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver)
        return <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
          target.$transaction(async (tx) => {
            let findManyCalls = 0
            const att = new Proxy(tx.acquisitionAttachment, {
              get(t, p, r) {
                if (p === "updateMany" && hook.updateCount !== undefined) {
                  return async (args: Prisma.AcquisitionAttachmentUpdateManyArgs) => {
                    await t.updateMany(args)
                    return { count: hook.updateCount }
                  }
                }
                if (p === "findMany" && hook.tamperSecondFindMany) {
                  return async (args: Prisma.AcquisitionAttachmentFindManyArgs) => {
                    const rows = (await t.findMany(args)) as Array<Record<string, unknown>>
                    findManyCalls++
                    return findManyCalls >= 2 ? rows.map((x, i) => (i === 0 ? { ...x, category: "UNKNOWN" } : x)) : rows
                  }
                }
                return Reflect.get(t, p, r)
              },
            })
            const proxiedTx = new Proxy(tx, {
              get(t, p, r) {
                return p === "acquisitionAttachment" ? att : Reflect.get(t, p, r)
              },
            })
            return fn(proxiedTx)
          })
      },
    }) as PrismaClient
  }

  it("P-4 — updateMany réel puis count ≠ 6 → UPDATE_COUNT_MISMATCH, rollback PostgreSQL complet", async () => {
    const before = await snapshot()
    const out = await runInlineNeutralizationTransaction(withTxHook({ updateCount: 5 }), new Date())
    assert.deepEqual(out, { outcome: "UPDATE_COUNT_MISMATCH" })
    assert.deepEqual(await snapshot(), before)
  })

  it("P-5 — relecture post-update incorrecte → POST_READ_MISMATCH, rollback PostgreSQL complet", async () => {
    const before = await snapshot()
    const out = await runInlineNeutralizationTransaction(withTxHook({ tamperSecondFindMany: true }), new Date())
    assert.deepEqual(out, { outcome: "POST_READ_MISMATCH" })
    assert.deepEqual(await snapshot(), before)
  })

  it("P-6 — REJECTED jamais repris par download / retry / reclaim", async () => {
    assert.equal((await runInlineNeutralizationTransaction(dbA, new Date())).outcome, "NEUTRALIZED")
    const repo = new AcquisitionAttachmentRepository(dbA)
    const discovered = await repo.listDiscoveredAttachmentsForCompany({ companyId: COMPANY, limit: 100 })
    assert.deepEqual(discovered.map((d) => d.id), [OTHER_ID])
    const before = await snapshot()
    for (const id of IDS) {
      assert.equal((await repo.claimForDownload(COMPANY, id)).status, "NOT_RETRYABLE")
      assert.equal(
        await repo.scheduleRetryToDiscovered({
          companyId: COMPANY,
          attachmentId: id,
          now: new Date(Date.now() + 86_400_000),
          maxRetries: 100,
          retryableErrorCodes: ["INLINE_MIME_EMBEDDED", "ATTACHMENT_STORAGE_FAILED"],
        }),
        "NOOP"
      )
      assert.equal(
        await repo.reclaimPendingDownload({ companyId: COMPANY, attachmentId: id, olderThan: new Date(Date.now() + 86_400_000) }),
        "NOOP"
      )
    }
    assert.deepEqual(await snapshot(), before)
  })

  it("P-7 — conversion du draft : aucun Document depuis les 6 REJECTED", async () => {
    assert.equal((await runInlineNeutralizationTransaction(dbA, new Date())).outcome, "NEUTRALIZED")
    await dbA.worksiteImportDraft.deleteMany({ where: { companyId: COMPANY } })
    await dbA.worksiteImportDraft.create({
      data: {
        id: DRAFT_ID,
        companyId: COMPANY,
        acquisitionMessageId: MESSAGE,
        status: "APPROVED",
        version: 3,
        proposedWorksiteName: "Chantier PG inline",
        proposedAddress: "1 rue PG",
        proposedPostalCode: "75001",
        proposedCity: "Paris",
        proposedStartDate: new Date("2027-06-01T00:00:00.000Z"),
        proposedClientId: CLIENT_ID,
      },
    })
    const saved = {
      master: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
      conv: process.env.ACQUISITION_CONVERSION_ENABLED,
    }
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONVERSION_ENABLED = "true"
    try {
      const svc = new ImportDraftConversionService({ db: dbA, geocode: { geocodeAddress: async () => null }, log: () => undefined })
      const r = await svc.convertImportDraft(
        { actorUserId: USER_ID, actorRole: "ADMIN", companyId: COMPANY },
        { draftId: DRAFT_ID, expectedVersion: 3, clientMode: "EXISTING", existingClientId: CLIENT_ID }
      )
      assert.equal(r.ok, true, JSON.stringify(r))
      if (r.ok) {
        assert.equal(r.outcome, "CONVERTED")
        assert.equal(r.documentCount, 0)
        assert.equal(r.skippedAttachmentCount, 7)
        const docs = await dbA.document.findMany({ where: { worksiteId: r.worksiteId } })
        assert.deepEqual(docs, [])
      }
    } finally {
      if (saved.master === undefined) delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
      else process.env.PLANIFICATOR_ACQUISITION_ENABLED = saved.master
      if (saved.conv === undefined) delete process.env.ACQUISITION_CONVERSION_ENABLED
      else process.env.ACQUISITION_CONVERSION_ENABLED = saved.conv
    }
    const after = await snapshot()
    assert.ok(after.filter((a) => IDS.includes(a.id)).every((a) => a.status === "REJECTED"))
  })

  it("P-8 — concurrence FOR UPDATE vs claimForDownload : jamais d'état mixte", async () => {
    for (let round = 0; round < 5; round++) {
      await seedAttachments()
      const repoB = new AcquisitionAttachmentRepository(dbB)
      const [neutralized, claim] = await Promise.all([
        runInlineNeutralizationTransaction(dbA, new Date()),
        repoB.claimForDownload(COMPANY, IDS[round % 6]!),
      ])
      const rows = (await snapshot()).filter((a) => IDS.includes(a.id))
      if (neutralized.outcome === "NEUTRALIZED") {
        assert.equal(claim.status, "NOT_RETRYABLE", JSON.stringify(claim))
        assert.ok(rows.every((a) => a.status === "REJECTED"))
      } else {
        assert.equal(neutralized.outcome, "PRECONDITION_FAILED")
        assert.equal(claim.status, "CLAIMED")
        assert.equal(rows.filter((a) => a.status === "PENDING_DOWNLOAD").length, 1)
        assert.equal(rows.filter((a) => a.status === "DISCOVERED").length, 5)
        assert.ok(rows.every((a) => a.lastErrorCode === null))
      }
    }
  })
})
