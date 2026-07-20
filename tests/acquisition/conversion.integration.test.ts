/**
 * PLAN-ACQ-005D — Intégration PostgreSQL conversion.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { ImportDraftConversionService } from "@/lib/acquisition/conversion/conversion.service"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL && /^postgres(ql)?:\/\//.test(TEST_URL))

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = {
  skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL absent ou invalide",
}

describe("acquisition conversion — intégration PostgreSQL 005D", RUN, () => {
  let companyA = ""
  let companyB = ""
  const envBackup = {
    master: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    conv: process.env.ACQUISITION_CONVERSION_ENABLED,
  }

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONVERSION_ENABLED = "true"
    const suffix = Date.now().toString(36)
    const a = await db.company.create({
      data: { name: `AcqConvA-${suffix}`, slug: `acq-conv-a-${suffix}` },
    })
    const b = await db.company.create({
      data: { name: `AcqConvB-${suffix}`, slug: `acq-conv-b-${suffix}` },
    })
    companyA = a.id
    companyB = b.id
  })

  after(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.master
    process.env.ACQUISITION_CONVERSION_ENABLED = envBackup.conv
    for (const companyId of [companyA, companyB]) {
      if (!companyId) continue
      const drafts = await db.worksiteImportDraft.findMany({
        where: { companyId },
        select: { createdWorksiteId: true },
      })
      const worksiteIds = drafts
        .map((d) => d.createdWorksiteId)
        .filter((id): id is string => Boolean(id))
      if (worksiteIds.length) {
        await db.document.deleteMany({ where: { worksiteId: { in: worksiteIds } } })
        await db.worksiteImportDraft.updateMany({
          where: { companyId },
          data: { createdWorksiteId: null },
        })
        await db.worksite.deleteMany({ where: { id: { in: worksiteIds } } })
      }
      await db.worksiteImportDraft.deleteMany({ where: { companyId } })
      await db.acquisitionAttachment.deleteMany({ where: { companyId } })
      await db.acquisitionMessage.deleteMany({ where: { companyId } })
      await db.client.deleteMany({ where: { companyId } })
      await db.user.deleteMany({ where: { companyId } }).catch(() => undefined)
      await db.company.delete({ where: { id: companyId } }).catch(() => undefined)
    }
    await db.$disconnect()
  })

  async function seedApproved(companyId: string) {
    const reg = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-005d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Consultation conversion 005D",
        receivedAt: new Date(),
        attachments: [],
      },
      db
    )
    assert.ok(reg.draftId)
    await db.worksiteImportDraft.update({
      where: { id: reg.draftId! },
      data: {
        status: "APPROVED",
        proposedWorksiteName: "Chantier Conv",
        proposedStartDate: new Date("2026-11-01T00:00:00.000Z"),
        proposedEndDate: new Date("2026-11-20T00:00:00.000Z"),
        version: 3,
      },
    })
    return reg.draftId!
  }

  async function admin(companyId: string) {
    const user = await db.user.create({
      data: {
        email: `conv-${Date.now()}@test.local`,
        name: "Converter",
        password: "hashed-not-used",
        role: "ADMIN",
        companyId,
      },
    })
    return {
      user,
      ctx: { actorUserId: user.id, actorRole: "ADMIN" as const, companyId },
    }
  }

  it("NEW convert + double convert concurrent + zéro Team/Assignment", async () => {
    const draftId = await seedApproved(companyA)
    const { ctx, user } = await admin(companyA)
    const svc = new ImportDraftConversionService({ db })

    const teamsBefore = await db.team.count({ where: { companyId: companyA } })
    const assignBefore = await db.assignment.count({
      where: { worksite: { companyId: companyA } },
    })

    const [a, b] = await Promise.all([
      svc.convertImportDraft(ctx, {
        draftId,
        expectedVersion: 3,
        clientMode: "NEW",
        newClient: { name: "Client Conv", email: null, phone: null, address: null },
      }),
      svc.convertImportDraft(ctx, {
        draftId,
        expectedVersion: 3,
        clientMode: "NEW",
        newClient: { name: "Client Conv 2", email: null, phone: null, address: null },
      }),
    ])

    const winners = [a, b].filter((r) => r.ok && r.outcome === "CONVERTED")
    const already = [a, b].filter((r) => r.ok && r.outcome === "ALREADY_CONVERTED")
    const conflicts = [a, b].filter((r) => !r.ok && r.outcome === "STATE_CHANGED")
    assert.equal(winners.length, 1)
    assert.equal(already.length + conflicts.length, 1)

    const worksites = await db.worksite.count({ where: { companyId: companyA } })
    assert.equal(worksites, 1)

    const retry = await svc.convertImportDraft(ctx, {
      draftId,
      expectedVersion: 99,
      clientMode: "NEW",
      newClient: { name: "Ignore", email: null, phone: null, address: null },
    })
    assert.equal(retry.ok, true)
    if (retry.ok) assert.equal(retry.outcome, "ALREADY_CONVERTED")

    assert.equal(await db.team.count({ where: { companyId: companyA } }), teamsBefore)
    assert.equal(
      await db.assignment.count({ where: { worksite: { companyId: companyA } } }),
      assignBefore
    )

    await db.user.delete({ where: { id: user.id } }).catch(() => undefined)
  })

  it("EXISTING cross-tenant CLIENT_NOT_FOUND", async () => {
    const draftId = await seedApproved(companyA)
    const draftBefore = await db.worksiteImportDraft.findUniqueOrThrow({
      where: { id: draftId },
      select: { status: true, version: true, createdWorksiteId: true },
    })
    const foreign = await db.client.create({
      data: { name: "Foreign", companyId: companyB },
    })
    const { ctx, user } = await admin(companyA)
    const svc = new ImportDraftConversionService({ db })

    const worksitesBefore = await db.worksite.count({ where: { companyId: companyA } })
    const clientsBefore = await db.client.count({ where: { companyId: companyA } })
    const documentsBefore = await db.document.count({
      where: { worksite: { companyId: companyA } },
    })
    const teamsBefore = await db.team.count({ where: { companyId: companyA } })
    const assignBefore = await db.assignment.count({
      where: { worksite: { companyId: companyA } },
    })

    const r = await svc.convertImportDraft(ctx, {
      draftId,
      expectedVersion: 3,
      clientMode: "EXISTING",
      existingClientId: foreign.id,
    })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.outcome, "CLIENT_NOT_FOUND")
      assert.equal(r.code, "CLIENT_NOT_FOUND")
    }

    const draftAfter = await db.worksiteImportDraft.findUniqueOrThrow({
      where: { id: draftId },
      select: { status: true, version: true, createdWorksiteId: true },
    })
    assert.equal(draftAfter.status, draftBefore.status)
    assert.equal(draftAfter.version, draftBefore.version)
    assert.equal(draftAfter.createdWorksiteId, draftBefore.createdWorksiteId)
    assert.equal(draftAfter.status, "APPROVED")
    assert.equal(draftAfter.createdWorksiteId, null)

    assert.equal(await db.worksite.count({ where: { companyId: companyA } }), worksitesBefore)
    assert.equal(await db.client.count({ where: { companyId: companyA } }), clientsBefore)
    assert.equal(
      await db.document.count({ where: { worksite: { companyId: companyA } } }),
      documentsBefore
    )
    assert.equal(await db.team.count({ where: { companyId: companyA } }), teamsBefore)
    assert.equal(
      await db.assignment.count({ where: { worksite: { companyId: companyA } } }),
      assignBefore
    )

    await db.client.delete({ where: { id: foreign.id } }).catch(() => undefined)
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined)
  })

  it("Document bridge url null + delete DB only", async () => {
    const draftId = await seedApproved(companyA)
    const draft = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: draftId } })
    await db.acquisitionAttachment.create({
      data: {
        companyId: companyA,
        acquisitionMessageId: draft.acquisitionMessageId,
        attachmentKey: `ord:0-${Date.now()}`,
        filename: "plan.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12,
        category: "PLAN",
        status: "STORED",
        storagePublicId: `pid/conv/${Date.now()}`,
        sha256: "b".repeat(64),
        storedAt: new Date(),
      },
    })
    const { ctx, user } = await admin(companyA)
    const svc = new ImportDraftConversionService({ db })
    const r = await svc.convertImportDraft(ctx, {
      draftId,
      expectedVersion: 3,
      clientMode: "NEW",
      newClient: { name: "Doc Client", email: null, phone: null, address: null },
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.documentCount, 1)

    const doc = await db.document.findFirst({
      where: { worksiteId: r.worksiteId },
    })
    assert.ok(doc)
    assert.equal(doc.url, null)
    assert.ok(doc.sourceAcquisitionAttachmentId)
    assert.ok(doc.storagePublicId)

    await db.document.delete({ where: { id: doc.id } })
    const att = await db.acquisitionAttachment.findUnique({
      where: { id: doc.sourceAcquisitionAttachmentId! },
    })
    assert.ok(att)
    assert.equal(att.storagePublicId, doc.storagePublicId)

    await db.user.delete({ where: { id: user.id } }).catch(() => undefined)
  })
})
