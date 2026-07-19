process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { AcquisitionMessageContentRepository } from "@/lib/acquisition/content/message-content.repository"
import { sanitizeMessageBodyParts } from "@/lib/acquisition/content/message-content-sanitizer"
import { fetchAndStoreMessageContent } from "@/lib/acquisition/content/message-content.service"
import type { AcquisitionMessageContentSourcePort } from "@/lib/acquisition/content/message-content-source.port"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

describe("acquisition message content — intégration PostgreSQL", RUN, () => {
  let companyA = ""
  let companyB = ""
  let messageA = ""

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"

    const a = await db.company.create({
      data: { name: "Content A", slug: `content-a-${Date.now()}` },
    })
    const b = await db.company.create({
      data: { name: "Content B", slug: `content-b-${Date.now()}` },
    })
    companyA = a.id
    companyB = b.id

    const reg = await registerIncomingMessage(
      {
        companyId: companyA,
        source: "GMAIL",
        externalMessageId: `ext-content-${Date.now()}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Consultation test contenu",
        receivedAt: new Date(),
        attachments: [],
      },
      db
    )
    assert.equal(reg.outcome, "DRAFT_CREATED")
    messageA = reg.messageId
  })

  after(async () => {
    if (!enabled) return
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

  it("upsert idempotent + isolation tenant", async () => {
    const repo = new AcquisitionMessageContentRepository(db)
    const sanitized = sanitizeMessageBodyParts({
      textPlain: "Texte normalisé contenu",
      textHtml: null,
      mimeType: "text/plain",
      charset: "utf-8",
      providerMessageId: "g",
      byteLengthOriginal: 24,
    })
    const first = await repo.upsertNormalized({
      companyId: companyA,
      acquisitionMessageId: messageA,
      sanitized,
      fetchedAt: new Date(),
    })
    assert.equal(first.outcome, "FETCHED")

    const second = await repo.upsertNormalized({
      companyId: companyA,
      acquisitionMessageId: messageA,
      sanitized,
      fetchedAt: new Date(),
    })
    assert.equal(second.outcome, "ALREADY_FETCHED")
    assert.equal(second.record.id, first.record.id)

    const cross = await repo.findByMessage(companyB, messageA)
    assert.equal(cross, null)
  })

  it("refuse relation cross-tenant à la création", async () => {
    // Deux messages distincts : le @unique(acquisitionMessageId) ne doit pas
    // masquer la FK composite. On attache le message de B avec le companyId de A.
    const regB = await registerIncomingMessage(
      {
        companyId: companyB,
        source: "GMAIL",
        externalMessageId: `ext-content-b-${Date.now()}`,
        senderEmail: "carlene@lauralu.fr",
        subject: "Consultation tenant B",
        receivedAt: new Date(),
        attachments: [],
      },
      db
    )
    assert.equal(regB.outcome, "DRAFT_CREATED")
    const messageB = regB.messageId

    // Aucune ligne content pour messageB → P2002 unique impossible.
    // (messageB, companyA) n'existe pas dans acquisition_messages → P2003 FK.
    await assert.rejects(
      () =>
        db.acquisitionMessageContent.create({
          data: {
            companyId: companyA,
            acquisitionMessageId: messageB,
            normalizedText: "leak",
            contentHash: "x",
            fetchedAt: new Date(),
            sanitizedAt: new Date(),
          },
        }),
      (err: { code?: string; meta?: { field_name?: string; constraint?: string } }) => {
        assert.equal(err?.code, "P2003", `attendu P2003 FK, reçu ${err?.code}`)
        assert.notEqual(err?.code, "P2002")
        return true
      }
    )
  })

  it("service fetch avec source mock persistée", async () => {
    const source: AcquisitionMessageContentSourcePort = {
      async fetchMessageBody() {
        return {
          textPlain: "Contenu service intégration",
          textHtml: "<b>ignore</b>",
          mimeType: "multipart/alternative",
          charset: "utf-8",
          providerMessageId: "gmail-int",
          byteLengthOriginal: 40,
        }
      },
    }

    const result = await fetchAndStoreMessageContent(
      {
        actor: { userId: "admin-int", role: "ADMIN", companyId: companyA },
        acquisitionMessageId: messageA,
      },
      { db, source }
    )
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.ok(result.content.normalizedText.includes("Contenu service"))
      assert.equal(result.content.companyId, companyA)
    }
  })
})
