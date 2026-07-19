/**
 * PLAN-ACQ-005B — Intégration PostgreSQL (invariants SQL).
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 * Prérequis : migration 20260719210000 appliquée sur la BDD de test.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { AcquisitionMessageContentRepository } from "@/lib/acquisition/content/message-content.repository"
import { sanitizeMessageBodyParts } from "@/lib/acquisition/content/message-content-sanitizer"
import { DraftExtractionRepository } from "@/lib/acquisition/extraction/extraction.repository"
import { runDraftExtraction } from "@/lib/acquisition/extraction/extraction.service"
import type { ExtractionProviderPort } from "@/lib/acquisition/extraction/extraction-provider.port"
import { catalogWarning } from "@/lib/acquisition/extraction/extraction.schema"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

async function seedMessage(companyId: string, body: string, subject: string) {
  const reg = await registerIncomingMessage(
    {
      companyId,
      source: "GMAIL",
      externalMessageId: `ext-005b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderEmail: "carlene@lauralu.fr",
      subject,
      receivedAt: new Date(),
      attachments: [],
    },
    db
  )
  assert.equal(reg.outcome, "DRAFT_CREATED")
  assert.ok(reg.draftId)

  const sanitized = sanitizeMessageBodyParts({
    textPlain: body,
    textHtml: null,
    mimeType: "text/plain",
    charset: "utf-8",
    providerMessageId: "g",
    byteLengthOriginal: Buffer.byteLength(body, "utf8"),
  })
  const repo = new AcquisitionMessageContentRepository(db)
  await repo.upsertNormalized({
    companyId,
    acquisitionMessageId: reg.messageId,
    sanitized,
    fetchedAt: new Date(),
  })

  return {
    messageId: reg.messageId,
    draftId: reg.draftId!,
    contentHash: sanitized.contentHash,
  }
}

describe("acquisition extraction — intégration PostgreSQL 005B", RUN, () => {
  let companyA = ""
  let companyB = ""
  const envBackup = {
    master: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    content: process.env.ACQUISITION_CONTENT_FETCH_ENABLED,
    extraction: process.env.ACQUISITION_EXTRACTION_ENABLED,
    provider: process.env.ACQUISITION_EXTRACTION_PROVIDER,
    maxAttempts: process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS,
    reclaim: process.env.ACQUISITION_EXTRACTION_RECLAIM_TTL_MS,
  }

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
    delete process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS

    const a = await db.company.create({
      data: { name: "Extract A", slug: `extract-a-${Date.now()}` },
    })
    const b = await db.company.create({
      data: { name: "Extract B", slug: `extract-b-${Date.now()}` },
    })
    companyA = a.id
    companyB = b.id
  })

  after(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.master
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = envBackup.content
    process.env.ACQUISITION_EXTRACTION_ENABLED = envBackup.extraction
    process.env.ACQUISITION_EXTRACTION_PROVIDER = envBackup.provider
    process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS = envBackup.maxAttempts
    process.env.ACQUISITION_EXTRACTION_RECLAIM_TTL_MS = envBackup.reclaim

    if (!enabled) return
    await db.acquisitionMessageContent.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.worksiteImportDraft.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.acquisitionAttachment.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.acquisitionMessage.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await db.$disconnect()
  })

  const actor = { userId: "u-admin", role: "ADMIN" as const, companyId: "" }

  it("1. double claim concurrent — un seul gagne", async () => {
    actor.companyId = companyA
    const seeded = await seedMessage(
      companyA,
      "Chantier : Site Concurrent\nRéférence : REF-CC-1",
      "Test claim"
    )
    const repo = new DraftExtractionRepository(db)
    const draft = await repo.findDraft(companyA, seeded.draftId)
    assert.ok(draft)

    const now = new Date()
    const [c1, c2] = await Promise.all([
      repo.claimExtracting({
        companyId: companyA,
        draftId: seeded.draftId,
        expectedVersion: draft.version,
        allowedStatuses: ["PENDING_EXTRACTION", "FAILED"],
        now,
        reclaimBefore: new Date(now.getTime() - 60_000),
      }),
      repo.claimExtracting({
        companyId: companyA,
        draftId: seeded.draftId,
        expectedVersion: draft.version,
        allowedStatuses: ["PENDING_EXTRACTION", "FAILED"],
        now,
        reclaimBefore: new Date(now.getTime() - 60_000),
      }),
    ])
    const winners = [c1, c2].filter(Boolean)
    assert.equal(winners.length, 1)
    const fresh = await repo.findDraft(companyA, seeded.draftId)
    assert.equal(fresh?.status, "EXTRACTING")
    assert.equal(fresh?.extractionAttemptCount, 1)
  })

  it("2. EXTRACTING frais — non reclaimé", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : Site Frais\nRéférence : REF-FR-1",
      "Test frais"
    )
    const repo = new DraftExtractionRepository(db)
    const now = new Date()
    const claimed = await repo.claimExtracting({
      companyId: companyA,
      draftId: seeded.draftId,
      expectedVersion: 0,
      allowedStatuses: ["PENDING_EXTRACTION", "FAILED"],
      now,
      reclaimBefore: new Date(now.getTime() - 300_000),
    })
    assert.ok(claimed)

    const reclaim = await repo.claimExtracting({
      companyId: companyA,
      draftId: seeded.draftId,
      expectedVersion: claimed.version,
      allowedStatuses: ["PENDING_EXTRACTION", "FAILED"],
      now: new Date(),
      reclaimBefore: new Date(Date.now() - 300_000),
    })
    assert.equal(reclaim, null)
  })

  it("3. EXTRACTING expiré — reclaim possible", async () => {
    process.env.ACQUISITION_EXTRACTION_RECLAIM_TTL_MS = "60000"
    const seeded = await seedMessage(
      companyA,
      "Chantier : Site Expiré\nRéférence : REF-EX-1",
      "Test reclaim"
    )
    const repo = new DraftExtractionRepository(db)
    const old = new Date(Date.now() - 10 * 60_000)
    await db.worksiteImportDraft.update({
      where: { id: seeded.draftId },
      data: {
        status: "EXTRACTING",
        version: 1,
        extractionAttemptCount: 1,
        extractionStartedAt: old,
      },
    })
    const reclaimBefore = new Date(Date.now() - 60_000)
    const reclaimed = await repo.claimExtracting({
      companyId: companyA,
      draftId: seeded.draftId,
      expectedVersion: 1,
      allowedStatuses: ["PENDING_EXTRACTION", "FAILED"],
      now: new Date(),
      reclaimBefore,
    })
    assert.ok(reclaimed)
    assert.equal(reclaimed.status, "EXTRACTING")
    assert.equal(reclaimed.extractionAttemptCount, 2)
  })

  it("4. maxAttempts off-by-one — 3 claims OK, 4e refusé", async () => {
    process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS = "3"
    const seeded = await seedMessage(
      companyA,
      "Chantier : Site Attempts\nRéférence : REF-AT-1",
      "Test attempts"
    )
    actor.companyId = companyA

    const hanging: ExtractionProviderPort = {
      async extract() {
        throw Object.assign(new Error("PROVIDER_TIMEOUT"), { code: "PROVIDER_TIMEOUT" })
      },
    }

    for (let i = 1; i <= 3; i++) {
      const r = await runDraftExtraction(
        { actor, draftId: seeded.draftId },
        { repository: new DraftExtractionRepository(db), provider: hanging, timeoutMs: 5 }
      )
      assert.equal(r.ok, false)
      const d = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: seeded.draftId } })
      assert.equal(d.extractionAttemptCount, i)
      assert.equal(d.status, "FAILED")
    }

    const fourth = await runDraftExtraction(
      { actor, draftId: seeded.draftId },
      { repository: new DraftExtractionRepository(db), provider: hanging, timeoutMs: 5 }
    )
    assert.equal(fourth.ok, false)
    if (!fourth.ok) assert.equal(fourth.outcome, "MAX_ATTEMPTS_REACHED")
    const final = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: seeded.draftId } })
    assert.equal(final.extractionAttemptCount, 3)
  })

  it("5. worker A tardif ne peut pas écraser worker B", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : Site Race\nRéférence : REF-RC-1",
      "Test race"
    )
    const repo = new DraftExtractionRepository(db)
    const a = await repo.claimExtracting({
      companyId: companyA,
      draftId: seeded.draftId,
      expectedVersion: 0,
      allowedStatuses: ["PENDING_EXTRACTION", "FAILED"],
      now: new Date(Date.now() - 10 * 60_000),
      reclaimBefore: new Date(Date.now() - 60_000),
    })
    assert.ok(a)
    const versionA = a.version

    // Force expired for reclaim
    await db.worksiteImportDraft.update({
      where: { id: seeded.draftId },
      data: { extractionStartedAt: new Date(Date.now() - 10 * 60_000) },
    })

    const b = await repo.claimExtracting({
      companyId: companyA,
      draftId: seeded.draftId,
      expectedVersion: versionA,
      allowedStatuses: ["PENDING_EXTRACTION", "FAILED"],
      now: new Date(),
      reclaimBefore: new Date(Date.now() - 60_000),
    })
    assert.ok(b)

    const lateA = await repo.persistExtraction({
      companyId: companyA,
      draftId: seeded.draftId,
      expectedVersion: versionA,
      expectedContentHash: seeded.contentHash,
      status: "PENDING_REVIEW",
      fields: {
        worksiteName: "STALE-A",
        clientName: null,
        clientEmail: null,
        clientPhone: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        address: null,
        postalCode: null,
        city: null,
        requestedStartDate: null,
        requestedEndDate: null,
        consultationReference: null,
        description: null,
        attachmentClassifications: [],
      },
      confidenceData: {},
      warningData: [],
      extractedData: {},
      providerId: "deterministic",
      model: null,
      errorCode: null,
      now: new Date(),
    })
    assert.equal(lateA, "STATE_CHANGED")

    const okB = await repo.persistExtraction({
      companyId: companyA,
      draftId: seeded.draftId,
      expectedVersion: b.version,
      expectedContentHash: seeded.contentHash,
      status: "PENDING_REVIEW",
      fields: {
        worksiteName: "WINNER-B",
        clientName: null,
        clientEmail: null,
        clientPhone: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        address: null,
        postalCode: null,
        city: null,
        requestedStartDate: null,
        requestedEndDate: null,
        consultationReference: "REF-RC-1",
        description: null,
        attachmentClassifications: [],
      },
      confidenceData: {},
      warningData: [],
      extractedData: {},
      providerId: "deterministic",
      model: null,
      errorCode: null,
      now: new Date(),
    })
    assert.equal(okB, "OK")
    const final = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: seeded.draftId } })
    assert.equal(final.status, "PENDING_REVIEW")
    assert.equal(final.proposedWorksiteName, "WINNER-B")
  })

  it("6. contentHash modifié → stale atomique", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : Site Stale\nRéférence : REF-ST-1",
      "Test stale"
    )
    const repo = new DraftExtractionRepository(db)
    const claimed = await repo.claimExtracting({
      companyId: companyA,
      draftId: seeded.draftId,
      expectedVersion: 0,
      allowedStatuses: ["PENDING_EXTRACTION", "FAILED"],
      now: new Date(),
      reclaimBefore: new Date(Date.now() - 60_000),
    })
    assert.ok(claimed)

    await db.acquisitionMessageContent.updateMany({
      where: { companyId: companyA, acquisitionMessageId: seeded.messageId },
      data: { contentHash: "hash-changed-during-extract" },
    })

    const outcome = await repo.persistExtraction({
      companyId: companyA,
      draftId: seeded.draftId,
      expectedVersion: claimed.version,
      expectedContentHash: seeded.contentHash,
      status: "PENDING_REVIEW",
      fields: {
        worksiteName: "ShouldNotWin",
        clientName: null,
        clientEmail: null,
        clientPhone: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        address: null,
        postalCode: null,
        city: null,
        requestedStartDate: null,
        requestedEndDate: null,
        consultationReference: null,
        description: null,
        attachmentClassifications: [],
      },
      confidenceData: {},
      warningData: [],
      extractedData: {},
      providerId: "deterministic",
      model: null,
      errorCode: null,
      now: new Date(),
    })
    assert.equal(outcome, "STALE_CONTENT")
    const final = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: seeded.draftId } })
    assert.equal(final.status, "FAILED")
    assert.equal(final.lastExtractionErrorCode, "STALE_CONTENT")
    assert.notEqual(final.proposedWorksiteName, "ShouldNotWin")
  })

  it("7. cross-tenant — aucun claim/persist étranger", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : Site Tenant\nRéférence : REF-TN-1",
      "Test tenant"
    )
    const repo = new DraftExtractionRepository(db)
    const claim = await repo.claimExtracting({
      companyId: companyB,
      draftId: seeded.draftId,
      expectedVersion: 0,
      allowedStatuses: ["PENDING_EXTRACTION", "FAILED"],
      now: new Date(),
      reclaimBefore: new Date(Date.now() - 60_000),
    })
    assert.equal(claim, null)

    actor.companyId = companyB
    const result = await runDraftExtraction(
      { actor, draftId: seeded.draftId },
      { repository: repo }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.outcome, "NOT_FOUND")
  })

  it("8. persist count=0 → STATE_CHANGED", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : Site State\nRéférence : REF-SC-1",
      "Test state"
    )
    const repo = new DraftExtractionRepository(db)
    const outcome = await repo.persistExtraction({
      companyId: companyA,
      draftId: seeded.draftId,
      expectedVersion: 99,
      expectedContentHash: seeded.contentHash,
      status: "PENDING_REVIEW",
      fields: {
        worksiteName: "X",
        clientName: null,
        clientEmail: null,
        clientPhone: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        address: null,
        postalCode: null,
        city: null,
        requestedStartDate: null,
        requestedEndDate: null,
        consultationReference: null,
        description: null,
        attachmentClassifications: [],
      },
      confidenceData: {},
      warningData: [catalogWarning("CONTENT_INSUFFICIENT")],
      extractedData: {},
      providerId: "deterministic",
      model: null,
      errorCode: null,
      now: new Date(),
    })
    assert.equal(outcome, "STATE_CHANGED")
  })

  it("9. aucune écriture Client / Worksite / Document", async () => {
    const clientsBefore = await db.client.count({ where: { companyId: companyA } })
    const worksitesBefore = await db.worksite.count({ where: { companyId: companyA } })
    const docsBefore = await db.document.count({
      where: { worksite: { companyId: companyA } },
    })

    const seeded = await seedMessage(
      companyA,
      "Chantier : Site Clean\nClient : Acme SA\nAdresse : 10 rue de la Paix 75002 Paris\nRéférence : REF-CL-1",
      "Test clean"
    )
    actor.companyId = companyA
    const result = await runDraftExtraction(
      { actor, draftId: seeded.draftId },
      { repository: new DraftExtractionRepository(db) }
    )
    assert.equal(result.ok, true)

    assert.equal(await db.client.count({ where: { companyId: companyA } }), clientsBefore)
    assert.equal(await db.worksite.count({ where: { companyId: companyA } }), worksitesBefore)
    assert.equal(
      await db.document.count({ where: { worksite: { companyId: companyA } } }),
      docsBefore
    )

    const draft = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: seeded.draftId } })
    assert.equal(draft.status, "PENDING_REVIEW")
    assert.equal(draft.proposedClientId, null)
  })

  it("10. dates inversées → FAILED contrôlé", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : Site Dates\nDébut 2026-09-20 fin 2026-09-01",
      "Test dates"
    )
    actor.companyId = companyA
    const provider: ExtractionProviderPort = {
      async extract() {
        return {
          fields: {
            worksiteName: { value: "Site Dates", confidence: 0.35 },
            requestedStartDate: { value: "2026-09-20", confidence: 0.3 },
            requestedEndDate: { value: "2026-09-01", confidence: 0.3 },
          },
          warnings: [],
          providerMetadata: { providerId: "test" },
        }
      },
    }
    const result = await runDraftExtraction(
      { actor, draftId: seeded.draftId },
      { repository: new DraftExtractionRepository(db), provider }
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, "DATE_RANGE_INVALID")
    const draft = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: seeded.draftId } })
    assert.equal(draft.status, "FAILED")
  })
})
