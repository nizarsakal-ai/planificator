/**
 * PLAN-ACQ-OPS-004 — Intégration PostgreSQL + stress (sélection, reclaim, concurrence).
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { AcquisitionMessageContentRepository } from "@/lib/acquisition/content/message-content.repository"
import { sanitizeMessageBodyParts } from "@/lib/acquisition/content/message-content-sanitizer"
import { AcquisitionExtractionCronSelectionRepository } from "@/lib/acquisition/extraction/extraction-cron.selection.repository"
import { runAcquisitionExtractionCronOrchestrator } from "@/lib/acquisition/extraction/extraction-cron.orchestrator"
import { getExtractionCronConfig } from "@/lib/acquisition/extraction/extraction-cron-feature-flag"
import { DraftExtractionRepository } from "@/lib/acquisition/extraction/extraction.repository"
import {
  runDraftExtraction,
  runDraftExtractionSystem,
} from "@/lib/acquisition/extraction/extraction.service"
import type { ExtractionProviderPort } from "@/lib/acquisition/extraction/extraction-provider.port"

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
      externalMessageId: `ext-ops004-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

describe("OPS-004 extraction cron — intégration PostgreSQL", RUN, () => {
  let companyA = ""
  let companyB = ""
  const selection = () => new AcquisitionExtractionCronSelectionRepository(db)
  const envBackup = {
    master: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    content: process.env.ACQUISITION_CONTENT_FETCH_ENABLED,
    extraction: process.env.ACQUISITION_EXTRACTION_ENABLED,
    cron: process.env.ACQUISITION_EXTRACTION_CRON_ENABLED,
    provider: process.env.ACQUISITION_EXTRACTION_PROVIDER,
    maxAttempts: process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS,
    reclaim: process.env.ACQUISITION_EXTRACTION_RECLAIM_TTL_MS,
  }

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_CRON_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
    delete process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS

    const a = await db.company.create({
      data: { name: "Extract Cron A", slug: `extract-cron-a-${Date.now()}` },
    })
    const b = await db.company.create({
      data: { name: "Extract Cron B", slug: `extract-cron-b-${Date.now()}` },
    })
    companyA = a.id
    companyB = b.id
  })

  after(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.master
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = envBackup.content
    process.env.ACQUISITION_EXTRACTION_ENABLED = envBackup.extraction
    process.env.ACQUISITION_EXTRACTION_CRON_ENABLED = envBackup.cron
    process.env.ACQUISITION_EXTRACTION_PROVIDER = envBackup.provider
    process.env.ACQUISITION_EXTRACTION_MAX_ATTEMPTS = envBackup.maxAttempts
    process.env.ACQUISITION_EXTRACTION_RECLAIM_TTL_MS = envBackup.reclaim
    if (!enabled) return
    await db.worksiteImportDraft.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.acquisitionMessageContent.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.acquisitionMessage.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await db.$disconnect()
  })

  it("sélection tenant-scopée + FIFO", async () => {
    const older = await seedMessage(
      companyA,
      "Chantier : FIFO Old\nRéférence : REF-FIFO-1",
      "FIFO old"
    )
    await new Promise((r) => setTimeout(r, 20))
    const newer = await seedMessage(
      companyA,
      "Chantier : FIFO New\nRéférence : REF-FIFO-2",
      "FIFO new"
    )
    const other = await seedMessage(
      companyB,
      "Chantier : Other\nRéférence : REF-OTH-1",
      "Other tenant"
    )

    const cfg = getExtractionCronConfig()
    const candidates = await selection().listEligibleCandidatesForCompany({
      companyId: companyA,
      limit: 10,
      now: new Date(),
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    assert.ok(candidates.length >= 2)
    assert.equal(candidates[0]!.draftId, older.draftId)
    assert.ok(candidates.every((c) => c.companyId === companyA))
    assert.ok(!candidates.some((c) => c.draftId === other.draftId))
    assert.ok(candidates.some((c) => c.draftId === newer.draftId))
  })

  it("FAILED backoff dû / non dû + maxAttempts exclu", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : Backoff\nRéférence : REF-BO-1",
      "Backoff"
    )
    const now = new Date()
    await db.worksiteImportDraft.update({
      where: { id: seeded.draftId },
      data: {
        status: "FAILED",
        extractionAttemptCount: 1,
        lastExtractionErrorAt: new Date(now.getTime() - 30_000),
        lastExtractionErrorCode: "PROVIDER_TIMEOUT",
      },
    })
    const cfg = getExtractionCronConfig()
    let candidates = await selection().listEligibleCandidatesForCompany({
      companyId: companyA,
      limit: 50,
      now,
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    assert.ok(!candidates.some((c) => c.draftId === seeded.draftId))

    await db.worksiteImportDraft.update({
      where: { id: seeded.draftId },
      data: { lastExtractionErrorAt: new Date(now.getTime() - 120_000) },
    })
    candidates = await selection().listEligibleCandidatesForCompany({
      companyId: companyA,
      limit: 50,
      now,
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    assert.ok(candidates.some((c) => c.draftId === seeded.draftId))

    await db.worksiteImportDraft.update({
      where: { id: seeded.draftId },
      data: { extractionAttemptCount: cfg.maxAttempts },
    })
    candidates = await selection().listEligibleCandidatesForCompany({
      companyId: companyA,
      limit: 50,
      now,
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    assert.ok(!candidates.some((c) => c.draftId === seeded.draftId))
  })

  it("EXTRACTING stale sélectionnable ; non stale exclu", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : Stale Extracting\nRéférence : REF-SE-1",
      "Stale extracting"
    )
    const cfg = getExtractionCronConfig()
    const now = new Date()
    await db.worksiteImportDraft.update({
      where: { id: seeded.draftId },
      data: {
        status: "EXTRACTING",
        extractionAttemptCount: 1,
        extractionStartedAt: new Date(now.getTime() - 1_000),
      },
    })
    let candidates = await selection().listEligibleCandidatesForCompany({
      companyId: companyA,
      limit: 50,
      now,
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    assert.ok(!candidates.some((c) => c.draftId === seeded.draftId))

    await db.worksiteImportDraft.update({
      where: { id: seeded.draftId },
      data: {
        extractionStartedAt: new Date(now.getTime() - cfg.reclaimTtlMs - 1_000),
      },
    })
    candidates = await selection().listEligibleCandidatesForCompany({
      companyId: companyA,
      limit: 50,
      now,
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    assert.ok(candidates.some((c) => c.draftId === seeded.draftId))
  })

  it("FAILED sans lastExtractionErrorAt exclu ; content vide exclu", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : No ErrAt\nRéférence : REF-NE-1",
      "No err at"
    )
    const cfg = getExtractionCronConfig()
    const now = new Date()
    await db.worksiteImportDraft.update({
      where: { id: seeded.draftId },
      data: {
        status: "FAILED",
        extractionAttemptCount: 1,
        lastExtractionErrorAt: null,
      },
    })
    let candidates = await selection().listEligibleCandidatesForCompany({
      companyId: companyA,
      limit: 50,
      now,
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    assert.ok(!candidates.some((c) => c.draftId === seeded.draftId))

    const empty = await seedMessage(companyA, "x", "empty-content")
    await db.acquisitionMessageContent.update({
      where: { acquisitionMessageId: empty.messageId },
      data: { normalizedText: "" },
    })
    await db.worksiteImportDraft.update({
      where: { id: empty.draftId },
      data: { status: "PENDING_EXTRACTION" },
    })
    candidates = await selection().listEligibleCandidatesForCompany({
      companyId: companyA,
      limit: 50,
      now,
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    assert.ok(!candidates.some((c) => c.draftId === empty.draftId))
  })

  it("starvation overfetch : PENDING dû derrière > limit*5 FAILED non dus", async () => {
    const cfg = getExtractionCronConfig()
    const now = new Date()
    const company = (
      await db.company.create({
        data: { name: "Starve Int", slug: `starve-int-${Date.now()}` },
      })
    ).id
    try {
      const limit = 5
      for (let i = 0; i < limit * 5 + 3; i++) {
        const s = await seedMessage(company, `Chantier ND ${i}\nRéférence : REF-ND-${i}`, `nd-${i}`)
        await db.worksiteImportDraft.update({
          where: { id: s.draftId },
          data: {
            status: "FAILED",
            extractionAttemptCount: 1,
            lastExtractionErrorAt: new Date(now.getTime() - 5_000),
            createdAt: new Date(now.getTime() - 500_000 + i),
          },
        })
      }
      const due = await seedMessage(
        company,
        "Chantier : Due Behind\nRéférence : REF-DUE-1",
        "due-behind"
      )
      const candidates = await selection().listEligibleCandidatesForCompany({
        companyId: company,
        limit,
        now,
        maxAttempts: cfg.maxAttempts,
        reclaimTtlMs: cfg.reclaimTtlMs,
      })
      assert.ok(candidates.some((c) => c.draftId === due.draftId))
      assert.ok(candidates.every((c) => c.companyId === company))
    } finally {
      await db.worksiteImportDraft.deleteMany({ where: { companyId: company } })
      await db.acquisitionMessageContent.deleteMany({ where: { companyId: company } })
      await db.acquisitionMessage.deleteMany({ where: { companyId: company } })
      await db.company.delete({ where: { id: company } })
    }
  })

  it("ALREADY_EXTRACTED + conflit version concurrent", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : Already\nRéférence : REF-AL-1",
      "Already"
    )
    const repo = new DraftExtractionRepository(db)
    const first = await runDraftExtractionSystem(
      { companyId: companyA, draftId: seeded.draftId },
      { repository: repo }
    )
    assert.equal(first.ok, true)
    const second = await runDraftExtractionSystem(
      { companyId: companyA, draftId: seeded.draftId },
      { repository: repo }
    )
    assert.equal(second.ok, true)
    if (second.ok) assert.equal(second.outcome, "ALREADY_EXTRACTED")

    const hanging: ExtractionProviderPort = {
      async extract() {
        await new Promise((r) => setTimeout(r, 60))
        return {
          fields: {
            worksiteName: { value: "V", confidence: 0.9 },
            consultationReference: { value: "REF-VC-1", confidence: 0.9 },
          },
          warnings: [],
          providerMetadata: { providerId: "deterministic" },
        }
      },
    }
    const raceSeed = await seedMessage(
      companyA,
      "Chantier : Version Conflict\nRéférence : REF-VC-1",
      "Version conflict"
    )
    const r1 = runDraftExtractionSystem(
      { companyId: companyA, draftId: raceSeed.draftId },
      { repository: repo, provider: hanging }
    )
    const r2 = runDraftExtractionSystem(
      { companyId: companyA, draftId: raceSeed.draftId },
      { repository: repo, provider: hanging }
    )
    const pair = await Promise.all([r1, r2])
    const okExtracted = pair.filter((r) => r.ok && r.outcome === "EXTRACTED")
    assert.ok(okExtracted.length <= 1)
    const draft = await db.worksiteImportDraft.findUniqueOrThrow({
      where: { id: raceSeed.draftId },
    })
    assert.equal(draft.status, "PENDING_REVIEW")
    assert.ok(draft.companyId === companyA)
  })

  it("isolation tenant A/B explicite sur listing companies", async () => {
    const cfg = getExtractionCronConfig()
    const onlyB = await seedMessage(
      companyB,
      "Chantier : Only B\nRéférence : REF-OB-1",
      "Only B"
    )
    const companies = await selection().listCompanyIdsWithEligibleExtraction({
      limit: 100,
      now: new Date(),
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    if (companies.includes(companyB)) {
      const forB = await selection().listEligibleCandidatesForCompany({
        companyId: companyB,
        limit: 20,
        now: new Date(),
        maxAttempts: cfg.maxAttempts,
        reclaimTtlMs: cfg.reclaimTtlMs,
      })
      assert.ok(forB.every((c) => c.companyId === companyB))
      assert.ok(forB.some((c) => c.draftId === onlyB.draftId))
    }
    const forA = await selection().listEligibleCandidatesForCompany({
      companyId: companyA,
      limit: 20,
      now: new Date(),
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    assert.ok(!forA.some((c) => c.draftId === onlyB.draftId))
  })

  it("wrapper système extrait sans Role", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : System Wrap\nRéférence : REF-SW-1",
      "System wrap"
    )
    const result = await runDraftExtractionSystem(
      { companyId: companyA, draftId: seeded.draftId },
      { repository: new DraftExtractionRepository(db) }
    )
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.outcome, "EXTRACTED")
    const draft = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: seeded.draftId } })
    assert.equal(draft.status, "PENDING_REVIEW")
  })

  it("orchestrateur run : extraction batch + pas de PII dans logs agrégés", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : Batch Run\nRéférence : REF-BR-1",
      "SECRET_SUBJECT_SHOULD_NOT_APPEAR"
    )
    const logs: Array<{ event: string; payload?: Record<string, unknown> }> = []
    const result = await runAcquisitionExtractionCronOrchestrator({
      repository: selection(),
      extractDraft: ({ companyId, draftId, now }) =>
        runDraftExtractionSystem(
          { companyId, draftId, now },
          { repository: new DraftExtractionRepository(db) }
        ),
      isProviderConfigured: () => true,
      logger: (event, payload) => logs.push({ event, payload }),
      createRunId: () => "pg-batch",
      config: { ...getExtractionCronConfig(), maxPerCompany: 5, maxPerRun: 5 },
    })
    assert.ok(result.extracted >= 1 || result.alreadyExtracted >= 1)
    const blob = JSON.stringify(logs)
    assert.ok(!blob.includes("SECRET_SUBJECT"))
    assert.ok(!blob.includes("normalizedText"))
  })

  it("UI / cron concurrence — un seul persist PENDING_REVIEW", async () => {
    const seeded = await seedMessage(
      companyA,
      "Chantier : UI Cron Race\nRéférence : REF-UC-1",
      "UI cron race"
    )
    const hanging: ExtractionProviderPort = {
      async extract() {
        await new Promise((r) => setTimeout(r, 80))
        return {
          fields: {
            worksiteName: { value: "Race Winner", confidence: 0.9 },
            consultationReference: { value: "REF-UC-1", confidence: 0.9 },
          },
          warnings: [],
          providerMetadata: { providerId: "deterministic" },
        }
      },
    }
    const repo = new DraftExtractionRepository(db)
    const ui = runDraftExtraction(
      {
        actor: { userId: "u1", role: "ADMIN", companyId: companyA },
        draftId: seeded.draftId,
      },
      { repository: repo, provider: hanging }
    )
    const cron = runDraftExtractionSystem(
      { companyId: companyA, draftId: seeded.draftId },
      { repository: repo, provider: hanging }
    )
    const [a, b] = await Promise.all([ui, cron])
    const outcomes = [a, b].map((r) => (r.ok ? r.outcome : r.outcome))
    assert.ok(outcomes.includes("EXTRACTED") || outcomes.includes("ALREADY_EXTRACTED"))
    assert.ok(
      outcomes.includes("IN_PROGRESS") ||
        outcomes.includes("STATE_CHANGED") ||
        outcomes.filter((o) => o === "EXTRACTED" || o === "ALREADY_EXTRACTED").length === 1
    )
    const draft = await db.worksiteImportDraft.findUniqueOrThrow({ where: { id: seeded.draftId } })
    assert.equal(draft.status, "PENDING_REVIEW")
  })
})

describe("OPS-004 extraction cron — stress concurrence", RUN, () => {
  let companyId = ""

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_CRON_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
    const c = await db.company.create({
      data: { name: "Extract Stress", slug: `extract-stress-${Date.now()}` },
    })
    companyId = c.id
  })

  after(async () => {
    if (!enabled) return
    await db.worksiteImportDraft.deleteMany({ where: { companyId } })
    await db.acquisitionMessageContent.deleteMany({ where: { companyId } })
    await db.acquisitionMessage.deleteMany({ where: { companyId } })
    await db.company.delete({ where: { id: companyId } })
  })

  it("cron/cron ×3 — aucune double extraction persistée / version cohérente", async () => {
    for (let round = 0; round < 3; round++) {
      const seeded = await seedMessage(
        companyId,
        `Chantier : Stress ${round}\nRéférence : REF-STRESS-${round}`,
        `Stress ${round}`
      )
      const repo = new DraftExtractionRepository(db)
      const workers = Array.from({ length: 4 }, () =>
        runDraftExtractionSystem(
          { companyId, draftId: seeded.draftId },
          { repository: repo }
        )
      )
      const results = await Promise.all(workers)
      const extracted = results.filter((r) => r.ok && r.outcome === "EXTRACTED")
      const already = results.filter((r) => r.ok && r.outcome === "ALREADY_EXTRACTED")
      const races = results.filter(
        (r) => !r.ok && (r.outcome === "IN_PROGRESS" || r.outcome === "STATE_CHANGED")
      )
      assert.ok(extracted.length + already.length >= 1)
      assert.ok(extracted.length <= 1)
      assert.equal(extracted.length + already.length + races.length, results.length)

      const draft = await db.worksiteImportDraft.findUniqueOrThrow({
        where: { id: seeded.draftId },
      })
      assert.equal(draft.status, "PENDING_REVIEW")
      assert.ok(draft.version >= 1)

      const foreign = await db.worksiteImportDraft.findFirst({
        where: { id: seeded.draftId, companyId: { not: companyId } },
      })
      assert.equal(foreign, null)
    }
  })
})
