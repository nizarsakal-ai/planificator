// Tests d'intégration — téléchargement/stockage pièces jointes Acquisition.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { downloadAcquisitionAttachment } from "@/lib/acquisition/attachments/attachment-download.service"
import { AcquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import type { GmailAttachmentSourcePort } from "@/lib/acquisition/attachments/gmail-attachment-source.adapter"
import type { AttachmentStoragePort } from "@/lib/acquisition/attachments/attachment-storage.port"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

const PDF_BUFFER = Buffer.from("%PDF-1.4 integration test")

describe("acquisition attachments — intégration (BDD de test)", RUN, () => {
  let companyA = ""
  let companyB = ""
  let attachmentA = ""

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"

    const a = await db.company.create({
      data: { name: "Attach A", slug: `attach-a-${Date.now()}` },
    })
    const b = await db.company.create({
      data: { name: "Attach B", slug: `attach-b-${Date.now()}` },
    })
    companyA = a.id
    companyB = b.id

    const reg = await registerIncomingMessage(
      {
        companyId: companyA,
        source: "GMAIL",
        externalMessageId: `msg-att-${Date.now()}`,
        senderEmail: "user@lauralu.fr",
        subject: "PJ test",
        receivedAt: new Date(),
        attachments: [
          {
            externalAttachmentId: "gmail-att-1",
            filename: "plan.pdf",
            mimeType: "application/pdf",
            sizeBytes: PDF_BUFFER.length,
          },
        ],
      },
      db
    )
    assert.equal(reg.outcome, "DRAFT_CREATED")
    const att = await db.acquisitionAttachment.findFirstOrThrow({
      where: { companyId: companyA, acquisitionMessageId: reg.messageId },
    })
    attachmentA = att.id
  })

  after(async () => {
    await db.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await db.$disconnect()
  })

  it("transition DISCOVERED → PENDING_DOWNLOAD → STORED", async () => {
    const repository = new AcquisitionAttachmentRepository(db)
    const r = await downloadAcquisitionAttachment(
      { companyId: companyA, attachmentId: attachmentA },
      { repository, gmailSource: mockGmailSource(), storage: mockStorage(), log: () => {} }
    )
    assert.equal(r.outcome, "STORED")
    const row = await db.acquisitionAttachment.findFirstOrThrow({ where: { id: attachmentA } })
    assert.equal(row.status, "STORED")
    assert.ok(row.sha256)
  })

  it("idempotence ALREADY_STORED", async () => {
    const r = await downloadAcquisitionAttachment(
      { companyId: companyA, attachmentId: attachmentA },
      {
        repository: new AcquisitionAttachmentRepository(db),
        gmailSource: mockGmailSource(),
        storage: mockStorage(),
        log: () => {},
      }
    )
    assert.equal(r.outcome, "ALREADY_STORED")
  })

  it("claim atomique : un seul worker gagne", async () => {
    const reg = await registerIncomingMessage(
      {
        companyId: companyA,
        source: "GMAIL",
        externalMessageId: `msg-claim-${Date.now()}`,
        senderEmail: "user@lauralu.fr",
        subject: "claim",
        receivedAt: new Date(),
        attachments: [
          {
            externalAttachmentId: "gmail-att-claim",
            filename: "plan.pdf",
            mimeType: "application/pdf",
            sizeBytes: 100,
          },
        ],
      },
      db
    )
    const att = await db.acquisitionAttachment.findFirstOrThrow({
      where: { acquisitionMessageId: reg.messageId, companyId: companyA },
    })
    const repository = new AcquisitionAttachmentRepository(db)
    const [c1, c2] = await Promise.all([
      repository.claimForDownload(companyA, att.id),
      repository.claimForDownload(companyA, att.id),
    ])
    const claimed = [c1, c2].filter((c) => c.status === "CLAIMED")
    const inProgress = [c1, c2].filter((c) => c.status === "ALREADY_IN_PROGRESS")
    assert.equal(claimed.length, 1)
    assert.equal(inProgress.length, 1)
  })

  it("FAILED non claimable", async () => {
    const reg = await registerIncomingMessage(
      {
        companyId: companyA,
        source: "GMAIL",
        externalMessageId: `msg-failed-${Date.now()}`,
        senderEmail: "user@lauralu.fr",
        subject: "failed",
        receivedAt: new Date(),
        attachments: [
          {
            externalAttachmentId: "gmail-att-failed",
            filename: "plan.pdf",
            mimeType: "application/pdf",
            sizeBytes: 100,
          },
        ],
      },
      db
    )
    const att = await db.acquisitionAttachment.findFirstOrThrow({
      where: { acquisitionMessageId: reg.messageId, companyId: companyA },
    })
    await db.acquisitionAttachment.update({
      where: { id: att.id },
      data: { status: "FAILED", lastErrorCode: "ATTACHMENT_STORAGE_FAILED" },
    })
    const claim = await new AcquisitionAttachmentRepository(db).claimForDownload(companyA, att.id)
    assert.equal(claim.status, "NOT_RETRYABLE")
  })

  it("REJECTED non claimable", async () => {
    const reg = await registerIncomingMessage(
      {
        companyId: companyA,
        source: "GMAIL",
        externalMessageId: `msg-rejected-${Date.now()}`,
        senderEmail: "user@lauralu.fr",
        subject: "rejected",
        receivedAt: new Date(),
        attachments: [
          {
            externalAttachmentId: "gmail-att-rej",
            filename: "virus.exe",
            mimeType: "application/pdf",
            sizeBytes: 100,
          },
        ],
      },
      db
    )
    const att = await db.acquisitionAttachment.findFirstOrThrow({
      where: { acquisitionMessageId: reg.messageId, companyId: companyA },
    })
    await db.acquisitionAttachment.update({
      where: { id: att.id },
      data: { status: "REJECTED", lastErrorCode: "ATTACHMENT_MIME_NOT_ALLOWED" },
    })
    const claim = await new AcquisitionAttachmentRepository(db).claimForDownload(companyA, att.id)
    assert.equal(claim.status, "NOT_RETRYABLE")
  })

  it("isolation multi-tenant", async () => {
    const r = await downloadAcquisitionAttachment(
      { companyId: companyB, attachmentId: attachmentA },
      {
        repository: new AcquisitionAttachmentRepository(db),
        gmailSource: mockGmailSource(),
        storage: mockStorage(),
        log: () => {},
      }
    )
    assert.equal(r.errorCode, "ATTACHMENT_NOT_FOUND")
  })
})

function mockGmailSource(): GmailAttachmentSourcePort {
  return {
    fetchAttachment: async () => ({ data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length }),
  }
}

function mockStorage(): AttachmentStoragePort {
  let n = 0
  return {
    store: async (input) => {
      n += 1
      return {
        storageUrl: `https://cloudinary.test/${input.companyId}/${input.attachmentId}`,
        storagePublicId: `planificator/${input.companyId}/acquisition/${input.acquisitionMessageId}/${input.attachmentId}/file-${n}`,
        created: true,
      }
    },
    destroy: async () => {},
  }
}
