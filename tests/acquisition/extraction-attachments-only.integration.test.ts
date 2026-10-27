/**
 * PLAN-ACQ-MULTIMODAL — Intégration PostgreSQL : extraction « PJ seules » (MANUEL),
 * empreinte att1: recalculée en TX, staleness, AUTO toujours bloqué.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent. Base jetable uniquement.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { seedLauraluPartnerForCompany } from "./helpers/seed-lauralu-partner"
import { DraftExtractionRepository } from "@/lib/acquisition/extraction/extraction.repository"
import {
  runDraftExtraction,
  runDraftExtractionSystem,
} from "@/lib/acquisition/extraction/extraction.service"
import type { ExtractionProviderPort } from "@/lib/acquisition/extraction/extraction-provider.port"
import { buildFlateCompressedMultiBlockPdf } from "@/lib/acquisition/extraction/pdf-text-extract"
import { assertAutoDecisionSourceFreshInTransaction } from "@/lib/acquisition/policy/auto-decision-source-freshness"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)
const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)
const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

const PDF = buildFlateCompressedMultiBlockPdf([
  "BON DE COMMANDE CMD-2026-114",
  "Chantier : Residence Les Lilas",
  "Adresse : 12 rue des Lilas 75011 Paris",
])

async function seedAttachmentsOnly(companyId: string) {
  const reg = await registerIncomingMessage(
    {
      companyId,
      source: "GMAIL",
      externalMessageId: `ext-mm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderEmail: "carlene@lauralu.fr",
      subject: "Commande",
      receivedAt: new Date(),
      attachments: [
        { externalAttachmentId: "g-1", filename: "BC-2026-114.pdf", mimeType: "application/pdf", sizeBytes: PDF.length },
      ],
    },
    db
  )
  assert.equal(reg.outcome, "DRAFT_CREATED")
  await db.acquisitionAttachment.updateMany({
    where: { companyId, acquisitionMessageId: reg.messageId },
    data: { status: "STORED", storagePublicId: `acq/${companyId}/bc`, sha256: "sha-v1", storedAt: new Date() },
  })
  return { messageId: reg.messageId, draftId: reg.draftId! }
}

describe("extraction PJ seules — intégration PostgreSQL", RUN, () => {
  let companyId = ""
  const keys = [
    "PLANIFICATOR_ACQUISITION_ENABLED",
    "ACQUISITION_CONTENT_FETCH_ENABLED",
    "ACQUISITION_EXTRACTION_ENABLED",
    "ACQUISITION_EXTRACTION_PROVIDER",
    "ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED",
    "ACQUISITION_EXTRACTION_ATTACHMENTS_ENABLED",
  ] as const
  const backup: Record<string, string | undefined> = {}
  const actor = { userId: "u-admin", role: "ADMIN" as const, companyId: "" }
  const loadBytes = async () => PDF

  before(async () => {
    for (const k of keys) backup[k] = process.env[k]
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
    delete process.env.ACQUISITION_EXTRACTION_MULTIMODAL_ENABLED
    process.env.ACQUISITION_EXTRACTION_ATTACHMENTS_ENABLED = "true"
    const c = await db.company.create({ data: { name: "MM", slug: `mm-${Date.now()}` } })
    companyId = c.id
    actor.companyId = companyId
    await seedLauraluPartnerForCompany(db, companyId)
  })

  after(async () => {
    for (const k of keys) {
      if (backup[k] === undefined) delete process.env[k]
      else process.env[k] = backup[k]
    }
    if (!enabled) return
    await db.acquisitionMessageContent.deleteMany({ where: { companyId } })
    await db.worksiteImportDraft.deleteMany({ where: { companyId } })
    await db.acquisitionAttachment.deleteMany({ where: { companyId } })
    await db.acquisitionMessage.deleteMany({ where: { companyId } })
    await db.company.deleteMany({ where: { id: companyId } })
    await db.$disconnect()
  })

  it("MANUEL : mail sans contenu + bon de commande PDF → PENDING_REVIEW, empreinte att1:, issues persistées", async () => {
    const s = await seedAttachmentsOnly(companyId)
    const repo = new DraftExtractionRepository(db)
    const r = await runDraftExtraction({ actor, draftId: s.draftId }, { repository: repo, loadAttachmentBytes: loadBytes })
    assert.equal(r.ok, true, JSON.stringify(r))
    const d = await db.worksiteImportDraft.findFirstOrThrow({ where: { id: s.draftId } })
    assert.equal(d.status, "PENDING_REVIEW")
    assert.match(d.contentHashAtExtraction ?? "", /^att1:[0-9a-f]{64}$/)
    assert.match(d.proposedWorksiteName ?? "", /Lilas/)
    const extracted = d.extractedData as { sourceKind?: string; attachmentReadOutcomes?: unknown[] }
    assert.equal(extracted.sourceKind, "ATTACHMENTS_ONLY")
    const outcomes = extracted.attachmentReadOutcomes as Array<Record<string, unknown>>
    assert.equal(outcomes.length, 1)
    assert.deepEqual(
      { filename: outcomes[0].filename, kind: outcomes[0].kind, outcome: outcomes[0].outcome },
      { filename: "BC-2026-114.pdf", kind: "pdf", outcome: "READ_TEXT" }
    )
    // P1-1 — issue liée à l'id réel de la pièce en base.
    const att = await db.acquisitionAttachment.findFirstOrThrow({ where: { acquisitionMessageId: s.messageId } })
    assert.equal(outcomes[0].attachmentId, att.id)

    // Barrière AUTO en TX réelle (SELECT … FOR UPDATE) : toujours STALE.
    const fresh = await db.$transaction((tx) =>
      assertAutoDecisionSourceFreshInTransaction(tx, {
        companyId,
        draftId: s.draftId,
        expectedContentHash: d.contentHashAtExtraction!,
      })
    )
    assert.equal(fresh, "STALE")
  })

  it("AUTO (cron) : même message → CONTENT_MISSING, aucun claim", async () => {
    const s = await seedAttachmentsOnly(companyId)
    const r = await runDraftExtractionSystem(
      { companyId, draftId: s.draftId },
      { repository: new DraftExtractionRepository(db), loadAttachmentBytes: loadBytes }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "CONTENT_MISSING")
    const d = await db.worksiteImportDraft.findFirstOrThrow({ where: { id: s.draftId } })
    assert.equal(d.extractionAttemptCount, 0)
    assert.equal(d.status, "PENDING_EXTRACTION")
  })

  it("staleness TX : pièce re-stockée pendant l'appel provider → FAILED STALE_CONTENT", async () => {
    const s = await seedAttachmentsOnly(companyId)
    const provider: ExtractionProviderPort = {
      async extract() {
        await db.acquisitionAttachment.updateMany({
          where: { companyId, acquisitionMessageId: s.messageId },
          data: { sha256: "sha-v2" },
        })
        return {
          fields: { worksiteName: { value: "Residence Les Lilas", confidence: 0.8 } },
          warnings: [],
          providerMetadata: { providerId: "fake" },
        }
      },
    }
    const r = await runDraftExtraction(
      { actor, draftId: s.draftId },
      { repository: new DraftExtractionRepository(db), provider, loadAttachmentBytes: loadBytes }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "STALE_CONTENT")
    const d = await db.worksiteImportDraft.findFirstOrThrow({ where: { id: s.draftId } })
    assert.equal(d.status, "FAILED")
    assert.equal(d.lastExtractionErrorCode, "STALE_CONTENT")
    assert.equal(d.extractionRetryable, true)
  })

  it("staleness TX : texte du mail arrivé pendant l'appel provider → STALE_CONTENT", async () => {
    const s = await seedAttachmentsOnly(companyId)
    const provider: ExtractionProviderPort = {
      async extract() {
        await db.acquisitionMessageContent.create({
          data: {
            companyId,
            acquisitionMessageId: s.messageId,
            normalizedText: "Bonjour, chantier Tour Alpha",
            contentHash: "h".repeat(64),
            fetchedAt: new Date(),
            sanitizedAt: new Date(),
          },
        })
        return {
          fields: { worksiteName: { value: "Residence Les Lilas", confidence: 0.8 } },
          warnings: [],
          providerMetadata: { providerId: "fake" },
        }
      },
    }
    const r = await runDraftExtraction(
      { actor, draftId: s.draftId },
      { repository: new DraftExtractionRepository(db), provider, loadAttachmentBytes: loadBytes }
    )
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, "STALE_CONTENT")
  })
})
