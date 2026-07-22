process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { AcquisitionContentFetchStateRepository } from "@/lib/acquisition/content/message-content-fetch-state.repository"
import { AcquisitionMessageContentRepository } from "@/lib/acquisition/content/message-content.repository"
import { sanitizeMessageBodyParts } from "@/lib/acquisition/content/message-content-sanitizer"
import { fetchAndStoreMessageContentCore } from "@/lib/acquisition/content/message-content.service"
import type { AcquisitionMessageContentSourcePort } from "@/lib/acquisition/content/message-content-source.port"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

describe("OPS-003 content fetch state — intégration PostgreSQL", RUN, () => {
  let companyA = ""
  let companyB = ""
  let messageA = ""
  let messageB = ""

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"

    const a = await db.company.create({
      data: { name: "Content Cron A", slug: `content-cron-a-${Date.now()}` },
    })
    const b = await db.company.create({
      data: { name: "Content Cron B", slug: `content-cron-b-${Date.now()}` },
    })
    companyA = a.id
    companyB = b.id

    const regA = await registerIncomingMessage(
      {
        companyId: companyA,
        source: "GMAIL",
        externalMessageId: `ext-cron-a-${Date.now()}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Consultation cron A",
        receivedAt: new Date(),
        attachments: [],
      },
      db
    )
    assert.equal(regA.outcome, "DRAFT_CREATED")
    messageA = regA.messageId

    const regB = await registerIncomingMessage(
      {
        companyId: companyB,
        source: "GMAIL",
        externalMessageId: `ext-cron-b-${Date.now()}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Consultation cron B",
        receivedAt: new Date(),
        attachments: [],
      },
      db
    )
    assert.equal(regB.outcome, "DRAFT_CREATED")
    messageB = regB.messageId
  })

  after(async () => {
    if (!enabled) return
    await db.acquisitionContentFetchState.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.acquisitionMessageContent.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.worksiteImportDraft.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.acquisitionMessage.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await db.$disconnect()
  })

  it("sélection tenant-scopée + exclusion terminal + nextRetryAt", async () => {
    const repo = new AcquisitionContentFetchStateRepository(db)
    const now = new Date()

    const companies = await repo.listCompanyIdsWithEligibleContentFetch({ limit: 50, now })
    assert.ok(companies.includes(companyA))
    assert.ok(companies.includes(companyB))

    const candidatesA = await repo.listEligibleCandidatesForCompany({
      companyId: companyA,
      limit: 10,
      now,
    })
    assert.equal(candidatesA.length, 1)
    assert.equal(candidatesA[0]?.acquisitionMessageId, messageA)

    await repo.markPermanentFailure({
      companyId: companyA,
      acquisitionMessageId: messageA,
      errorCode: "CONTENT_EMPTY",
      now,
    })

    const afterTerminal = await repo.listEligibleCandidatesForCompany({
      companyId: companyA,
      limit: 10,
      now: new Date(),
    })
    assert.equal(afterTerminal.length, 0)

    const cross = await repo.listEligibleCandidatesForCompany({
      companyId: companyB,
      limit: 10,
      now: new Date(),
    })
    assert.equal(cross.length, 1)
    assert.equal(cross[0]?.acquisitionMessageId, messageB)
  })

  it("retryable pose nextRetryAt puis exclut jusqu'au délai", async () => {
    const repo = new AcquisitionContentFetchStateRepository(db)
    const now = new Date()
    await repo.markRetryableFailure({
      companyId: companyB,
      acquisitionMessageId: messageB,
      errorCode: "GMAIL_RATE_LIMITED",
      now,
      maxAttempts: 5,
    })
    const immediate = await repo.listEligibleCandidatesForCompany({
      companyId: companyB,
      limit: 10,
      now,
    })
    assert.equal(immediate.length, 0)

    const later = await repo.listEligibleCandidatesForCompany({
      companyId: companyB,
      limit: 10,
      now: new Date(now.getTime() + 60 * 60_000),
    })
    assert.equal(later.length, 1)
  })

  it("concurrence core → une seule row content ; pas de terminalisation", async () => {
    // reset state B pour ce scénario
    await db.acquisitionContentFetchState.deleteMany({ where: { companyId: companyB } })

    const source: AcquisitionMessageContentSourcePort = {
      fetchMessageBody: async () => ({
        textPlain: "Concurrent body",
        textHtml: null,
        mimeType: "text/plain",
        charset: "utf-8",
        providerMessageId: "g-conc",
        byteLengthOriginal: 15,
      }),
    }

    const [r1, r2] = await Promise.all([
      fetchAndStoreMessageContentCore(
        { companyId: companyB, acquisitionMessageId: messageB, logActorId: "t1" },
        { db, source }
      ),
      fetchAndStoreMessageContentCore(
        { companyId: companyB, acquisitionMessageId: messageB, logActorId: "t2" },
        { db, source }
      ),
    ])

    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    const count = await db.acquisitionMessageContent.count({
      where: { companyId: companyB, acquisitionMessageId: messageB },
    })
    assert.equal(count, 1)

    const states = await db.acquisitionContentFetchState.count({
      where: { companyId: companyB, acquisitionMessageId: messageB, terminalAt: { not: null } },
    })
    assert.equal(states, 0)
  })

  it("P2002 upsert concurrent remappé ALREADY_FETCHED|UPDATED", async () => {
    await db.acquisitionMessageContent.deleteMany({ where: { companyId: companyA } })
    await db.acquisitionContentFetchState.deleteMany({ where: { companyId: companyA } })

    // Réactiver éligibilité A : clear terminal from earlier test
    // messageA was terminalized — recreate eligibility by clearing state
    const contentRepo = new AcquisitionMessageContentRepository(db)
    const sanitized = sanitizeMessageBodyParts({
      textPlain: "P2002 body",
      textHtml: null,
      mimeType: "text/plain",
      charset: "utf-8",
      providerMessageId: "g",
      byteLengthOriginal: 9,
    })

    const first = await contentRepo.upsertNormalized({
      companyId: companyA,
      acquisitionMessageId: messageA,
      sanitized,
      fetchedAt: new Date(),
    })
    assert.equal(first.outcome, "FETCHED")

    const second = await contentRepo.upsertNormalized({
      companyId: companyA,
      acquisitionMessageId: messageA,
      sanitized,
      fetchedAt: new Date(),
    })
    assert.equal(second.outcome, "ALREADY_FETCHED")
  })

  it("FetchState : incréments concurrents atomiques sans perte + ON CONFLICT DO NOTHING", async () => {
    await db.acquisitionMessageContent.deleteMany({
      where: { companyId: companyA, acquisitionMessageId: messageA },
    })
    await db.acquisitionContentFetchState.deleteMany({
      where: { companyId: companyA, acquisitionMessageId: messageA },
    })

    const repo = new AcquisitionContentFetchStateRepository(db)
    const now = new Date()
    const n = 12
    const results = await Promise.all(
      Array.from({ length: n }, () =>
        repo.markRetryableFailure({
          companyId: companyA,
          acquisitionMessageId: messageA,
          errorCode: "GMAIL_RATE_LIMITED",
          now,
          maxAttempts: 100,
        })
      )
    )

    const rows = await db.acquisitionContentFetchState.findMany({
      where: { companyId: companyA, acquisitionMessageId: messageA },
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.attemptCount, n)
    assert.equal(rows[0]?.terminalAt, null)
    assert.ok(results.every((r) => !r.skippedDueToContent))
    assert.equal(
      results.map((r) => r.attemptCount).sort((a, b) => a - b).join(","),
      Array.from({ length: n }, (_, i) => i + 1).join(",")
    )
  })

  it("FetchState : retryable concurrent après permanente → terminalAt préservé", async () => {
    await db.acquisitionMessageContent.deleteMany({
      where: { companyId: companyA, acquisitionMessageId: messageA },
    })
    await db.acquisitionContentFetchState.deleteMany({
      where: { companyId: companyA, acquisitionMessageId: messageA },
    })

    const repo = new AcquisitionContentFetchStateRepository(db)
    const t0 = new Date("2026-07-22T00:00:00.000Z")
    await repo.markPermanentFailure({
      companyId: companyA,
      acquisitionMessageId: messageA,
      errorCode: "CONTENT_EMPTY",
      now: t0,
    })
    const before = await db.acquisitionContentFetchState.findFirst({
      where: { companyId: companyA, acquisitionMessageId: messageA },
    })
    assert.ok(before?.terminalAt)

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.markRetryableFailure({
          companyId: companyA,
          acquisitionMessageId: messageA,
          errorCode: "GMAIL_RATE_LIMITED",
          now: new Date("2026-07-22T00:01:00.000Z"),
          maxAttempts: 100,
        })
      )
    )

    const after = await db.acquisitionContentFetchState.findFirst({
      where: { companyId: companyA, acquisitionMessageId: messageA },
    })
    assert.ok(after)
    assert.equal(after.terminalAt?.toISOString(), before!.terminalAt!.toISOString())
    assert.equal(after.nextRetryAt, null)
    assert.equal(after.attemptCount, 1 + 8)
    assert.ok(results.every((r) => r.terminal === true))
  })

  it("FetchState : content présent → mark failure skipped, pas de terminal", async () => {
    const repo = new AcquisitionContentFetchStateRepository(db)
    await db.acquisitionContentFetchState.deleteMany({
      where: { companyId: companyA, acquisitionMessageId: messageA },
    })
    // content déjà créé par test précédent éventuel — assurer présence
    const contentRepo = new AcquisitionMessageContentRepository(db)
    const existing = await contentRepo.findByMessage(companyA, messageA)
    if (!existing) {
      await contentRepo.upsertNormalized({
        companyId: companyA,
        acquisitionMessageId: messageA,
        sanitized: sanitizeMessageBodyParts({
          textPlain: "guard body",
          textHtml: null,
          mimeType: "text/plain",
          charset: "utf-8",
          providerMessageId: "g",
          byteLengthOriginal: 10,
        }),
        fetchedAt: new Date(),
      })
    }

    const marked = await repo.markPermanentFailure({
      companyId: companyA,
      acquisitionMessageId: messageA,
      errorCode: "CONTENT_EMPTY",
      now: new Date(),
    })
    assert.equal(marked.skippedDueToContent, true)
    assert.equal(marked.terminal, false)

    const terminalRows = await db.acquisitionContentFetchState.count({
      where: {
        companyId: companyA,
        acquisitionMessageId: messageA,
        terminalAt: { not: null },
      },
    })
    assert.equal(terminalRows, 0)
  })
})
