/**
 * PLAN-ACQ-OPS-004-R1 — Starvation / sélection SQL (nécessite TEST_ACQUISITION_DATABASE_URL).
 * Ne mocke pas une liste déjà filtrée : exerce le repository réel contre PostgreSQL.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { AcquisitionMessageContentRepository } from "@/lib/acquisition/content/message-content.repository"
import { sanitizeMessageBodyParts } from "@/lib/acquisition/content/message-content-sanitizer"
import { AcquisitionExtractionCronSelectionRepository } from "@/lib/acquisition/extraction/extraction-cron.selection.repository"
import { getExtractionCronConfig } from "@/lib/acquisition/extraction/extraction-cron-feature-flag"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

async function seedDraft(companyId: string, label: string) {
  const reg = await registerIncomingMessage(
    {
      companyId,
      source: "GMAIL",
      externalMessageId: `ext-starve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderEmail: "carlene@lauralu.fr",
      subject: label,
      receivedAt: new Date(),
      attachments: [],
    },
    db
  )
  assert.equal(reg.outcome, "DRAFT_CREATED")
  assert.ok(reg.draftId)
  const body = `Chantier : ${label}\nRéférence : REF-${label.slice(0, 12)}`
  const sanitized = sanitizeMessageBodyParts({
    textPlain: body,
    textHtml: null,
    mimeType: "text/plain",
    charset: "utf-8",
    providerMessageId: "g",
    byteLengthOriginal: Buffer.byteLength(body, "utf8"),
  })
  await new AcquisitionMessageContentRepository(db).upsertNormalized({
    companyId,
    acquisitionMessageId: reg.messageId,
    sanitized,
    fetchedAt: new Date(),
  })
  return { draftId: reg.draftId!, messageId: reg.messageId }
}

describe("OPS-004-R1 sélection — anti-starvation PostgreSQL", RUN, () => {
  let companyDue = ""
  let companyOnlyNondue = ""
  let companyHiddenDue = ""
  const selection = () => new AcquisitionExtractionCronSelectionRepository(db)

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const stamp = Date.now()
    companyDue = (
      await db.company.create({
        data: { name: "Starve Due", slug: `starve-due-${stamp}` },
      })
    ).id
    companyOnlyNondue = (
      await db.company.create({
        data: { name: "Starve Nondue", slug: `starve-nondue-${stamp}` },
      })
    ).id
    companyHiddenDue = (
      await db.company.create({
        data: { name: "Starve Hidden", slug: `starve-hidden-${stamp}` },
      })
    ).id
  })

  after(async () => {
    if (!enabled) return
    const ids = [companyDue, companyOnlyNondue, companyHiddenDue]
    await db.worksiteImportDraft.deleteMany({ where: { companyId: { in: ids } } })
    await db.acquisitionMessageContent.deleteMany({ where: { companyId: { in: ids } } })
    await db.acquisitionMessage.deleteMany({ where: { companyId: { in: ids } } })
    await db.company.deleteMany({ where: { id: { in: ids } } })
    await db.$disconnect()
  })

  it("limit*5 FAILED non dus avant PENDING dû → dû retourné ; maxPerCompany après éligibilité", async () => {
    const cfg = getExtractionCronConfig()
    const now = new Date()
    const limit = 3
    const nondueCount = limit * 5 + 2
    const nondueIds: string[] = []
    for (let i = 0; i < nondueCount; i++) {
      const s = await seedDraft(companyDue, `nondue-${i}`)
      nondueIds.push(s.draftId)
      await db.worksiteImportDraft.update({
        where: { id: s.draftId },
        data: {
          status: "FAILED",
          extractionAttemptCount: 1,
          lastExtractionErrorAt: new Date(now.getTime() - 10_000),
          createdAt: new Date(now.getTime() - 1_000_000 + i),
        },
      })
    }
    const due = await seedDraft(companyDue, "pending-due")
    await db.worksiteImportDraft.update({
      where: { id: due.draftId },
      data: { createdAt: new Date(now.getTime() - 500) },
    })

    const candidates = await selection().listEligibleCandidatesForCompany({
      companyId: companyDue,
      limit,
      now,
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    assert.ok(candidates.some((c) => c.draftId === due.draftId))
    assert.ok(candidates.every((c) => c.companyId === companyDue))
    assert.ok(!candidates.some((c) => nondueIds.includes(c.draftId)))
    assert.ok(candidates.length <= limit)
    const ids = candidates.map((c) => c.draftId)
    assert.equal(new Set(ids).size, ids.length)
  })

  it(">500 non-dus avant plusieurs dus → FIFO entre éligibles uniquement", async () => {
    const cfg = getExtractionCronConfig()
    const now = new Date()
    const company = (
      await db.company.create({
        data: { name: "Starve 500", slug: `starve-500-${Date.now()}` },
      })
    ).id
    try {
      const bulk = 520
      const messageRows = Array.from({ length: bulk }, (_, i) => {
        const id = `msg_nd_${company.slice(-8)}_${i}`
        return {
          id,
          companyId: company,
          source: "GMAIL" as const,
          externalMessageId: `ext-bulk-nd-${i}-${Date.now()}`,
          senderEmail: "carlene@lauralu.fr",
          senderDomain: "lauralu.fr",
          subject: `bulk-nd-${i}`,
          receivedAt: now,
          status: "DRAFT_CREATED" as const,
        }
      })
      await db.acquisitionMessage.createMany({ data: messageRows })
      await db.acquisitionMessageContent.createMany({
        data: messageRows.map((m, i) => ({
          id: `cnt_nd_${company.slice(-8)}_${i}`,
          companyId: company,
          acquisitionMessageId: m.id,
          normalizedText: `Chantier bulk ${i}`,
          contentHash: `hash-nd-${i}`,
          fetchedAt: now,
          sanitizedAt: now,
          byteLengthOriginal: 20,
        })),
      })
      await db.worksiteImportDraft.createMany({
        data: messageRows.map((m, i) => ({
          id: `dft_nd_${company.slice(-8)}_${i}`,
          companyId: company,
          acquisitionMessageId: m.id,
          status: "FAILED" as const,
          extractionAttemptCount: 2,
          lastExtractionErrorAt: new Date(now.getTime() - 5_000),
          createdAt: new Date(now.getTime() - 2_000_000 + i),
          updatedAt: now,
        })),
      })

      const dueA = await seedDraft(company, "due-a")
      await new Promise((r) => setTimeout(r, 15))
      const dueB = await seedDraft(company, "due-b")
      await db.worksiteImportDraft.update({
        where: { id: dueA.draftId },
        data: { createdAt: new Date(now.getTime() - 100) },
      })
      await db.worksiteImportDraft.update({
        where: { id: dueB.draftId },
        data: { createdAt: new Date(now.getTime() - 50) },
      })

      const candidates = await selection().listEligibleCandidatesForCompany({
        companyId: company,
        limit: 10,
        now,
        maxAttempts: cfg.maxAttempts,
        reclaimTtlMs: cfg.reclaimTtlMs,
      })
      assert.equal(candidates.length, 2)
      assert.equal(candidates[0]!.draftId, dueA.draftId)
      assert.equal(candidates[1]!.draftId, dueB.draftId)
      assert.ok(candidates.every((c) => c.companyId === company))
    } finally {
      await db.worksiteImportDraft.deleteMany({ where: { companyId: company } })
      await db.acquisitionMessageContent.deleteMany({ where: { companyId: company } })
      await db.acquisitionMessage.deleteMany({ where: { companyId: company } })
      await db.company.delete({ where: { id: company } })
    }
  })

  it("listing companies : tenant uniquement non-dus absent ; tenant dû après non-dus présent", async () => {
    const cfg = getExtractionCronConfig()
    const now = new Date()

    const onlyNd = await seedDraft(companyOnlyNondue, "only-nd")
    await db.worksiteImportDraft.update({
      where: { id: onlyNd.draftId },
      data: {
        status: "FAILED",
        extractionAttemptCount: 1,
        lastExtractionErrorAt: new Date(now.getTime() - 5_000),
      },
    })

    for (let i = 0; i < 30; i++) {
      const s = await seedDraft(companyHiddenDue, `hid-nd-${i}`)
      await db.worksiteImportDraft.update({
        where: { id: s.draftId },
        data: {
          status: "FAILED",
          extractionAttemptCount: 1,
          lastExtractionErrorAt: new Date(now.getTime() - 5_000),
          createdAt: new Date(now.getTime() - 100_000 + i),
        },
      })
    }
    await seedDraft(companyHiddenDue, "hid-due")

    const companies = await selection().listCompanyIdsWithEligibleExtraction({
      limit: 50,
      now,
      maxAttempts: cfg.maxAttempts,
      reclaimTtlMs: cfg.reclaimTtlMs,
    })
    assert.ok(!companies.includes(companyOnlyNondue))
    assert.ok(companies.includes(companyHiddenDue))
    assert.deepEqual([...companies].sort(), companies)
  })
})
