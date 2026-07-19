/**
 * PLAN-ACQ-005C — Intégration PostgreSQL revue (R1).
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { ImportDraftReadRepository } from "@/lib/acquisition/review/import-draft-read.repository"
import { ImportDraftReviewService } from "@/lib/acquisition/review/import-draft-review.service"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

async function businessCounts(companyId: string) {
  const [clients, worksites, documents, teams, assignments] = await Promise.all([
    db.client.count({ where: { companyId } }),
    db.worksite.count({ where: { companyId } }),
    db.document.count({ where: { worksite: { companyId } } }),
    db.team.count({ where: { companyId } }),
    db.assignment.count({ where: { worksite: { companyId } } }),
  ])
  return { clients, worksites, documents, teams, assignments }
}

describe("acquisition review — intégration PostgreSQL 005C", RUN, () => {
  let companyA = ""
  let companyB = ""
  const envBackup = {
    master: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
  }

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const suffix = Date.now().toString(36)
    const a = await db.company.create({
      data: { name: `AcqRevA-${suffix}`, slug: `acq-rev-a-${suffix}` },
    })
    const b = await db.company.create({
      data: { name: `AcqRevB-${suffix}`, slug: `acq-rev-b-${suffix}` },
    })
    companyA = a.id
    companyB = b.id
  })

  after(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.master
    for (const companyId of [companyA, companyB]) {
      if (!companyId) continue
      await db.worksiteImportDraft.deleteMany({ where: { companyId } })
      await db.acquisitionAttachment.deleteMany({ where: { companyId } })
      await db.acquisitionMessageContent.deleteMany({ where: { companyId } }).catch(() => undefined)
      await db.acquisitionMessage.deleteMany({ where: { companyId } })
      await db.user.deleteMany({ where: { companyId } }).catch(() => undefined)
      await db.company.delete({ where: { id: companyId } }).catch(() => undefined)
    }
    await db.$disconnect()
  })

  async function seedDraft(
    companyId: string,
    over: {
      status?: "PENDING_REVIEW" | "FAILED" | "PENDING_EXTRACTION"
      updatedAt?: Date
      warningData?: unknown
    } = {}
  ) {
    const reg = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-005c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Consultation test 005C",
        receivedAt: new Date(),
        attachments: [],
      },
      db
    )
    assert.ok(reg.draftId)
    await db.worksiteImportDraft.update({
      where: { id: reg.draftId! },
      data: {
        status: over.status ?? "PENDING_REVIEW",
        proposedWorksiteName: "Chantier Test",
        proposedStartDate: new Date("2026-10-01T00:00:00.000Z"),
        proposedEndDate: new Date("2026-10-15T00:00:00.000Z"),
        warningData: over.warningData ?? [],
        version: 1,
        ...(over.updatedAt ? { updatedAt: over.updatedAt } : {}),
      },
    })
    return reg.draftId!
  }

  async function adminCtx(companyId: string) {
    const user = await db.user.create({
      data: {
        email: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
        name: "Reviewer",
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

  it("liste tenant A uniquement + filtre + tri updatedAt DESC", async () => {
    const older = await seedDraft(companyA, { updatedAt: new Date("2026-01-01T00:00:00.000Z") })
    const newer = await seedDraft(companyA, { updatedAt: new Date("2026-06-01T00:00:00.000Z") })
    await seedDraft(companyB)

    const repo = new ImportDraftReadRepository(db)
    const list = await repo.listImportDraftsForReview({ companyId: companyA, limit: 50 })
    assert.ok(list.some((x) => x.draftId === older))
    assert.ok(list.some((x) => x.draftId === newer))
    const idsB = await db.worksiteImportDraft.findMany({
      where: { companyId: companyB },
      select: { id: true },
    })
    assert.ok(idsB.length > 0)
    assert.ok(list.every((x) => !idsB.some((b) => b.id === x.draftId)))

    const idxNewer = list.findIndex((x) => x.draftId === newer)
    const idxOlder = list.findIndex((x) => x.draftId === older)
    assert.ok(idxNewer >= 0 && idxOlder >= 0)
    assert.ok(idxNewer < idxOlder)

    const filtered = await repo.listImportDraftsForReview({
      companyId: companyA,
      status: "PENDING_REVIEW",
    })
    assert.ok(filtered.every((x) => x.status === "PENDING_REVIEW"))

    const serialized = JSON.stringify(list)
    assert.equal(serialized.includes("storagePublicId"), false)
    assert.equal(serialized.includes("externalAttachmentId"), false)
    assert.equal(serialized.includes("partId"), false)
    assert.equal(serialized.includes("rawMetadata"), false)
  })

  it("limite maximum 50", async () => {
    const repo = new ImportDraftReadRepository(db)
    // Stratégie réelle mais bornée : créer 52 drafts via messages + drafts liés.
    for (let i = 0; i < 52; i++) {
      await seedDraft(companyA, {
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      })
    }
    const list = await repo.listImportDraftsForReview({ companyId: companyA, limit: 999 })
    assert.equal(list.length, 50)
  })

  it("bundle + status snapshot cross-tenant null ; pas de secrets", async () => {
    const idA = await seedDraft(companyA)
    await db.acquisitionAttachment.create({
      data: {
        companyId: companyA,
        acquisitionMessageId: (
          await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: idA } })
        ).acquisitionMessageId,
        attachmentKey: `ord:0-${Date.now()}`,
        filename: "plan.pdf",
        mimeType: "application/pdf",
        category: "UNKNOWN",
        sizeBytes: 12,
        status: "STORED",
        storagePublicId: "secret/public/id",
        sha256: "a".repeat(64),
        storedAt: new Date(),
      },
    })

    const repo = new ImportDraftReadRepository(db)
    assert.equal(
      await repo.getImportDraftReviewBundle({ companyId: companyB, draftId: idA }),
      null
    )
    assert.equal(
      await repo.getImportDraftStatusForReview({ companyId: companyB, draftId: idA }),
      null
    )

    const ok = await repo.getImportDraftReviewBundle({ companyId: companyA, draftId: idA })
    assert.ok(ok)
    assert.equal(ok.attachments.length, 1)
    const attJson = JSON.stringify(ok.attachments)
    assert.equal(attJson.includes("storagePublicId"), false)
    assert.equal(attJson.includes("secret/public"), false)
    assert.equal(attJson.includes("externalAttachmentId"), false)

    const status = await repo.getImportDraftStatusForReview({
      companyId: companyA,
      draftId: idA,
    })
    assert.ok(status)
    assert.equal(status.id, idA)
    assert.equal(Object.keys(status).sort().join(","), "id,status,version")
  })

  it("optimistic lock save + double approve + zéro métier", async () => {
    const before = await businessCounts(companyA)
    const draftId = await seedDraft(companyA)
    const { ctx, user } = await adminCtx(companyA)
    const svc = new ImportDraftReviewService({ db })

    const save1 = await svc.saveImportDraftCorrections(ctx, {
      draftId,
      expectedVersion: 1,
      proposedWorksiteName: "V1",
      proposedClientName: null,
      proposedAddress: null,
      proposedPostalCode: null,
      proposedCity: null,
      proposedStartDate: "2026-10-01",
      proposedEndDate: "2026-10-15",
      proposedDescription: null,
    })
    assert.equal(save1.ok, true)

    const [saveA, saveB] = await Promise.all([
      svc.saveImportDraftCorrections(ctx, {
        draftId,
        expectedVersion: 2,
        proposedWorksiteName: "A",
        proposedClientName: null,
        proposedAddress: null,
        proposedPostalCode: null,
        proposedCity: null,
        proposedStartDate: "2026-10-01",
        proposedEndDate: "2026-10-15",
        proposedDescription: null,
      }),
      svc.saveImportDraftCorrections(ctx, {
        draftId,
        expectedVersion: 2,
        proposedWorksiteName: "B",
        proposedClientName: null,
        proposedAddress: null,
        proposedPostalCode: null,
        proposedCity: null,
        proposedStartDate: "2026-10-01",
        proposedEndDate: "2026-10-15",
        proposedDescription: null,
      }),
    ])
    assert.equal([saveA, saveB].filter((r) => r.ok).length, 1)

    const draft = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: draftId } })
    const a1 = await svc.approveImportDraft(ctx, {
      draftId,
      expectedVersion: draft.version,
    })
    assert.equal(a1.ok, true)

    const a2 = await svc.approveImportDraft(ctx, {
      draftId,
      expectedVersion: draft.version,
    })
    assert.equal(a2.ok, false)
    if (!a2.ok) assert.ok(["STATE_CHANGED", "INVALID_STATE"].includes(a2.outcome))

    const after = await businessCounts(companyA)
    assert.deepEqual(after, before)
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined)
  })

  it("approve/reject concurrents : un seul gagne", async () => {
    const before = await businessCounts(companyA)
    const draftId = await seedDraft(companyA)
    const { ctx, user } = await adminCtx(companyA)
    const svc = new ImportDraftReviewService({ db })
    const draft = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: draftId } })

    const [approve, reject] = await Promise.all([
      svc.approveImportDraft(ctx, { draftId, expectedVersion: draft.version }),
      svc.rejectImportDraft(ctx, {
        draftId,
        expectedVersion: draft.version,
        rejectionReason: "Motif concurrent assez long",
      }),
    ])

    assert.equal([approve, reject].filter((r) => r.ok).length, 1)
    const final = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: draftId } })
    assert.ok(final.status === "APPROVED" || final.status === "REJECTED")
    assert.deepEqual(await businessCounts(companyA), before)
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined)
  })

  it("transitions FAILED + blocking inconnu", async () => {
    const failedId = await seedDraft(companyA, { status: "FAILED" })
    const { ctx, user } = await adminCtx(companyA)
    const svc = new ImportDraftReviewService({ db })

    const saveFailed = await svc.saveImportDraftCorrections(ctx, {
      draftId: failedId,
      expectedVersion: 1,
      proposedWorksiteName: "KeepFailed",
      proposedClientName: null,
      proposedAddress: null,
      proposedPostalCode: null,
      proposedCity: null,
      proposedStartDate: "2026-10-01",
      proposedEndDate: "2026-10-15",
      proposedDescription: null,
    })
    assert.equal(saveFailed.ok, true)
    const afterSave = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: failedId } })
    assert.equal(afterSave.status, "FAILED")

    const rejectFailed = await svc.rejectImportDraft(ctx, {
      draftId: failedId,
      expectedVersion: afterSave.version,
      rejectionReason: "Motif assez long",
    })
    assert.equal(rejectFailed.ok, false)
    if (!rejectFailed.ok) assert.equal(rejectFailed.outcome, "INVALID_STATE")

    const blockingId = await seedDraft(companyA, {
      warningData: [{ code: "CUSTOM_UNKNOWN", blocking: true, message: "raw-should-not-leak" }],
    })
    const draft = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: blockingId } })
    const blocked = await svc.approveImportDraft(ctx, {
      draftId: blockingId,
      expectedVersion: draft.version,
    })
    assert.equal(blocked.ok, false)
    if (!blocked.ok) assert.equal(blocked.outcome, "BLOCKING_WARNINGS")

    await db.user.delete({ where: { id: user.id } }).catch(() => undefined)
  })
})
