/**
 * PLAN-ACQ-AGENTS-LOT-3D/3E-CORRECTION-4A — concurrence PostgreSQL réelle.
 * Skip si TEST_ACQUISITION_DATABASE_URL absent.
 */

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { seedLauraluPartnerForCompany } from "./helpers/seed-lauralu-partner"
import {
  AcquisitionDecisionJournalRepository,
  buildAutoIntentIdempotencyKey,
  buildValidationDecisionIdempotencyKey,
} from "@/lib/acquisition/policy/decision-journal.repository"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const RUN = {
  skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini",
}

describe("CORRECTION-4A — PostgreSQL concurrent appendOnce", RUN, () => {
  const stamp = Date.now()
  let companyId = ""
  let draftId = ""
  let dbA: PrismaClient
  let dbB: PrismaClient

  before(async () => {
    dbA = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    dbB = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
    const company = await dbA.company.create({
      data: { name: "Idem Co", slug: `idem-${stamp}` },
    })
    companyId = company.id
    await seedLauraluPartnerForCompany(dbA, companyId)
    const reg = await registerIncomingMessage(
      {
        companyId,
        source: "GMAIL",
        externalMessageId: `ext-idem-${stamp}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Idempotency",
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
        contentHashAtExtraction: "idem-hash",
        extractionSchemaVersion: "2",
      },
    })
  })

  after(async () => {
    if (!enabled) return
    await dbA.acquisitionDecisionJournal.deleteMany({ where: { companyId } })
    await dbA.worksiteImportDraft.deleteMany({ where: { companyId } })
    await dbA.acquisitionMessageContent.deleteMany({ where: { companyId } })
    await dbA.acquisitionMessage.deleteMany({ where: { companyId } })
    await dbA.acquisitionPartnerDomain.deleteMany({ where: { companyId } })
    await dbA.acquisitionPartner.deleteMany({ where: { companyId } })
    await dbA.company.deleteMany({ where: { id: companyId } })
    await dbA.$disconnect()
    await dbB.$disconnect()
  })

  it("A — validation concurrente même slot → 1 ligne", async () => {
    const key = buildValidationDecisionIdempotencyKey({
      companyId,
      draftId,
      cycle: {
        contentHash: "idem-hash",
        extractionSchemaVersion: "2",
        draftVersion: 1,
      },
      validationAttempt: 1,
    })
    const repoA = new AcquisitionDecisionJournalRepository(dbA)
    const repoB = new AcquisitionDecisionJournalRepository(dbB)
    const entry = (code: string) => ({
      companyId,
      draftId,
      decisionCode: code,
      reasons: ["T"],
      scores: {},
      actorUserId: null as string | null,
      idempotencyKey: key,
      metadata: {
        contentHash: "idem-hash",
        extractionSchemaVersion: "2",
        draftVersion: 1,
        attempt: 1,
      },
    })

    const [r1, r2] = await Promise.all([
      repoA.appendOnce(entry("VALIDATION_PASS")),
      repoB.appendOnce(entry("VALIDATION_QUARANTINE")),
    ])
    const outcomes = [r1.outcome, r2.outcome].sort()
    assert.deepEqual(outcomes, ["ALREADY_EXISTS", "APPENDED"])
    assert.equal(r1.row.id, r2.row.id)

    const rows = await dbA.acquisitionDecisionJournal.findMany({
      where: { companyId, draftId, idempotencyKey: key },
    })
    assert.equal(rows.length, 1)
  })

  it("B — auto-intent contradictoire concurrent → 1 ligne + loser ALREADY_EXISTS", async () => {
    const frozen = {
      contentHash: "idem-hash",
      extractionSchemaVersion: "2",
      validatedDraftVersion: 1,
    }
    const key = buildAutoIntentIdempotencyKey({ companyId, draftId, frozen })
    const repoA = new AcquisitionDecisionJournalRepository(dbA)
    const repoB = new AcquisitionDecisionJournalRepository(dbB)
    const meta = {
      pipeline: "POST_EXTRACTION_STEPS",
      validationCycle: frozen,
    }

    const [r1, r2] = await Promise.all([
      repoA.appendOnce({
        companyId,
        draftId,
        decisionCode: "AUTO_APPROVE_CONVERT",
        reasons: ["C"],
        scores: {},
        actorUserId: null,
        idempotencyKey: key,
        metadata: meta,
      }),
      repoB.appendOnce({
        companyId,
        draftId,
        decisionCode: "HUMAN_REVIEW_REQUIRED",
        reasons: ["H"],
        scores: {},
        actorUserId: null,
        idempotencyKey: key,
        metadata: meta,
      }),
    ])
    const outcomes = [r1.outcome, r2.outcome].sort()
    assert.deepEqual(outcomes, ["ALREADY_EXISTS", "APPENDED"])
    const loser = r1.outcome === "ALREADY_EXISTS" ? r1 : r2
    const winner = r1.outcome === "APPENDED" ? r1 : r2
    assert.equal(loser.row.id, winner.row.id)
    assert.ok(
      loser.row.decisionCode === "AUTO_APPROVE_CONVERT" ||
        loser.row.decisionCode === "HUMAN_REVIEW_REQUIRED"
    )
    const rows = await dbA.acquisitionDecisionJournal.findMany({
      where: { idempotencyKey: key },
    })
    assert.equal(rows.length, 1)
  })

  it("C — attempt 1 puis attempt 2 → deux lignes (clés différentes)", async () => {
    const cycle = {
      contentHash: "idem-hash-2",
      extractionSchemaVersion: "2",
      draftVersion: 2,
    }
    const k1 = buildValidationDecisionIdempotencyKey({
      companyId,
      draftId,
      cycle,
      validationAttempt: 1,
    })
    const k2 = buildValidationDecisionIdempotencyKey({
      companyId,
      draftId,
      cycle,
      validationAttempt: 2,
    })
    assert.notEqual(k1, k2)
    const repo = new AcquisitionDecisionJournalRepository(dbA)
    const r1 = await repo.appendOnce({
      companyId,
      draftId,
      decisionCode: "VALIDATION_FAIL_RETRYABLE",
      reasons: ["R1"],
      scores: {},
      actorUserId: null,
      idempotencyKey: k1,
      metadata: { ...cycle, attempt: 1 },
    })
    const r2 = await repo.appendOnce({
      companyId,
      draftId,
      decisionCode: "VALIDATION_PASS",
      reasons: ["R2"],
      scores: {},
      actorUserId: null,
      idempotencyKey: k2,
      metadata: { ...cycle, attempt: 2 },
    })
    assert.equal(r1.outcome, "APPENDED")
    assert.equal(r2.outcome, "APPENDED")
    assert.notEqual(r1.row.id, r2.row.id)
    const count = await dbA.acquisitionDecisionJournal.count({
      where: {
        companyId,
        draftId,
        idempotencyKey: { in: [k1, k2] },
      },
    })
    assert.equal(count, 2)
  })
})
