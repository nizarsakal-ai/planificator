// Tests d'intégration — téléchargement/stockage pièces jointes Acquisition.
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"
process.env.GMAIL_TOKEN_ENCRYPTION_KEY ??= "test-encryption-key-32chars-min!!"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { encrypt } from "@/lib/encryption"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { seedLauraluPartnerForCompany } from "./helpers/seed-lauralu-partner"
import { downloadAcquisitionAttachment } from "@/lib/acquisition/attachments/attachment-download.service"
import { AcquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import type { AttachmentSourcePort } from "@/lib/acquisition/attachments/attachment-source.port"
import type { AttachmentStoragePort } from "@/lib/acquisition/attachments/attachment-storage.port"

import { gmailAdmissionKey } from "@/lib/acquisition/artifacts/gmail-admission-key"
import { resolveMailArtifactProvider } from "@/lib/acquisition/artifacts/resolve-mail-artifact-provider"
import { fetchAndStoreMessageContentCore } from "@/lib/acquisition/content/message-content.service"

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
  let mailboxA = ""

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"

    const a = await db.company.create({
      data: { name: "Attach A", slug: `attach-a-${Date.now()}` },
    })
    const b = await db.company.create({
      data: { name: "Attach B", slug: `attach-b-${Date.now()}` },
    })
    companyA = a.id
    companyB = b.id
    await seedLauraluPartnerForCompany(db, companyA)
    await seedLauraluPartnerForCompany(db, companyB)

    // Legacy sourceMailboxKey="" → exactement 1 connexion active (contrat Multi-Gmail).
    const mailbox = await db.acquisitionGmailConnection.create({
      data: {
        companyId: companyA,
        gmailAddress: `attach-a-${Date.now()}@example.com`,
        accessToken: encrypt("access-a"),
        refreshToken: encrypt("refresh-a"),
        tokenExpiry: new Date(Date.now() + 3600_000),
        connectedById: "test-user-attach",
        active: true,
      },
    })

    mailboxA = mailbox.id

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

  it("résout le corps et la pièce d’une admission via la connexion, la boîte et les capacités", async () => {
    const connection = await db.integrationConnection.create({
      data: {
        companyId: companyA, connectorType: "platform.mail.legacy", displayName: "Boîte fictive",
        status: "ACTIVE", secretBackend: "LEGACY_GMAIL", config: { gmailMailboxId: mailboxA },
      },
    })
    async function seedAdmission(externalMessageId: string, contentCapabilities: string[]) {
      const reg = await registerIncomingMessage({
        companyId: companyA, source: "GMAIL", sourceMailboxKey: mailboxA,
        externalMessageId, senderEmail: "user@lauralu.fr", subject: "Consultation fictive",
        receivedAt: new Date(), attachments: [
          { externalAttachmentId: "piece-fictive", filename: "plan.pdf", mimeType: "application/pdf", sizeBytes: PDF_BUFFER.length },
        ],
      }, db)
      assert.equal(reg.outcome, "DRAFT_CREATED")
      const envelope = await db.inboundEnvelope.create({
        data: {
          companyId: companyA, connectionId: connection.id, connectorType: connection.connectorType,
          externalId: externalMessageId, idempotencyKey: gmailAdmissionKey(externalMessageId),
          receivedAt: new Date(), payloadRef: "fixture", contentType: "message/rfc822", lifecycleStatus: "NORMALIZED",
        },
      })
      await db.normalizedInbound.create({
        data: {
          companyId: companyA, connectionId: connection.id, envelopeId: envelope.id,
          family: "MESSAGE", occurredAt: new Date(), receivedAt: new Date(), normalizedHash: "fixture",
          message: { externalMessageId, contentCapabilities },
        },
      })
      const attachment = await db.acquisitionAttachment.findFirstOrThrow({
        where: { companyId: companyA, acquisitionMessageId: reg.messageId },
      })
      return { messageId: reg.messageId, attachmentId: attachment.id, envelopeId: envelope.id }
    }

    const externalMessageId = "admission-artefacts"
    const fixture = await seedAdmission(externalMessageId, ["CONTENT_FETCHABLE", "ATTACHMENTS_FETCHABLE"])
    const body = await fetchAndStoreMessageContentCore(
      { companyId: companyA, acquisitionMessageId: fixture.messageId },
      { db, source: { fetchMessageBody: async (input) => {
        assert.equal(input.companyId, companyA)
        assert.equal(input.connectionId, mailboxA)
        assert.equal(input.externalMessageId, externalMessageId)
        return {
          textPlain: "Demande fictive", textHtml: null, mimeType: "text/plain", charset: "utf-8",
          providerMessageId: externalMessageId, byteLengthOriginal: 15,
        }
      } } }
    )
    assert.ok(body.ok)
    assert.equal(body.content.normalizedText, "Demande fictive")
    const result = await downloadAcquisitionAttachment(
      { companyId: companyA, attachmentId: fixture.attachmentId },
      {
        db, repository: new AcquisitionAttachmentRepository(db), storage: mockStorage(), log: () => {},
        source: { fetchAttachment: async (input) => {
          assert.equal(input.companyId, companyA)
          assert.equal(input.connectionId, mailboxA)
          assert.equal(input.externalMessageId, externalMessageId)
          assert.equal(input.externalAttachmentId, "piece-fictive")
          return { data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length }
        } },
      }
    )
    assert.equal(result.outcome, "STORED")
    const resolved = await resolveMailArtifactProvider(
      db, { companyId: companyA, sourceMailboxKey: mailboxA, externalMessageId }, "ARTIFACT_FETCH",
      { id: fixture.attachmentId, externalArtifactId: "piece-fictive" },
    )
    assert.ok(resolved.ok)
    assert.equal(resolved.artifact?.connectionId, connection.id)
    assert.equal(resolved.artifact?.envelopeId, fixture.envelopeId)
    assert.equal(resolved.artifact?.id, fixture.attachmentId)

    const blocked = await seedAdmission("admission-sans-capacites", [])
    const blockedBody = await fetchAndStoreMessageContentCore(
      { companyId: companyA, acquisitionMessageId: blocked.messageId },
      { db, source: { fetchMessageBody: async () => assert.fail("Aucun appel sans capacité de contenu") } },
    )
    assert.ok(!blockedBody.ok)
    assert.equal(blockedBody.code, "ARTIFACT_CAPABILITY_UNAVAILABLE")
    const blockedAttachment = await downloadAcquisitionAttachment(
      { companyId: companyA, attachmentId: blocked.attachmentId },
      {
        db, repository: new AcquisitionAttachmentRepository(db), storage: mockStorage(), log: () => {},
        source: { fetchAttachment: async () => assert.fail("Aucun appel sans capacité de pièce") },
      },
    )
    assert.equal(blockedAttachment.outcome, "FAILED")
    assert.equal(blockedAttachment.errorCode, "ARTIFACT_CAPABILITY_UNAVAILABLE")
  })

  it("transition DISCOVERED → PENDING_DOWNLOAD → STORED", async () => {
    const repository = new AcquisitionAttachmentRepository(db)
    const r = await downloadAcquisitionAttachment(
      { companyId: companyA, attachmentId: attachmentA },
      {
        db, repository, storage: mockStorage(), log: () => {},
        source: {
          fetchAttachment: async (input) => {
            assert.equal(input.companyId, companyA)
            assert.equal(input.connectionId, mailboxA)
            assert.equal(input.externalAttachmentId, "gmail-att-1")
            return { data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length }
          },
        },
      }
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
        db,
        repository: new AcquisitionAttachmentRepository(db),
        source: { fetchAttachment: async () => assert.fail("La pièce stockée ne doit pas être relue") },
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
        db,
        repository: new AcquisitionAttachmentRepository(db),
        source: mockAttachmentSource(),
        storage: mockStorage(),
        log: () => {},
      }
    )
    assert.equal(r.errorCode, "ATTACHMENT_NOT_FOUND")
  })
})

function mockAttachmentSource(): AttachmentSourcePort {
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
