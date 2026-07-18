process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import type { Role } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { accessAcquisitionAttachment } from "@/lib/acquisition/access/attachment-access.service"
import { AttachmentAccessRepository } from "@/lib/acquisition/access/attachment-access.repository"
import { AttachmentAccessAuditRepository } from "@/lib/acquisition/access/attachment-access-audit.repository"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

function streamBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]))
      c.close()
    },
  })
}

describe("acquisition attachment access — intégration PostgreSQL", RUN, () => {
  let companyA = ""
  let companyB = ""
  let userA = ""
  let storedAttachmentA = ""

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_ACCESS_ENABLED = "true"

    const a = await db.company.create({
      data: { name: "Access A", slug: `access-a-${Date.now()}` },
    })
    const b = await db.company.create({
      data: { name: "Access B", slug: `access-b-${Date.now()}` },
    })
    companyA = a.id
    companyB = b.id

    const user = await db.user.create({
      data: {
        email: `access-admin-${Date.now()}@test.fr`,
        password: "hash",
        role: "ADMIN" as Role,
        companyId: companyA,
      },
    })
    userA = user.id

    const reg = await registerIncomingMessage(
      {
        companyId: companyA,
        source: "GMAIL",
        externalMessageId: `msg-access-${Date.now()}`,
        senderEmail: "user@lauralu.fr",
        subject: "access test",
        receivedAt: new Date(),
        attachments: [
          {
            externalAttachmentId: "gmail-att-access",
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
    storedAttachmentA = att.id
    await db.acquisitionAttachment.update({
      where: { id: att.id },
      data: {
        status: "STORED",
        storagePublicId: "planificator/test/acquisition/stored.pdf",
        storageUrl: "https://res.cloudinary.com/x/raw/authenticated/v1/stored.pdf",
        sha256: "abc123456789",
        storedAt: new Date(),
      },
    })
  })

  after(async () => {
    await db.user.deleteMany({ where: { id: userA } })
    await db.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await db.$disconnect()
  })

  it("audit GRANTED persisté avec tenant/user/attachment corrects", async () => {
    const auditRepo = new AttachmentAccessAuditRepository(db)
    const r = await accessAcquisitionAttachment(
      {
        context: { userId: userA, role: "ADMIN", companyId: companyA },
        attachmentId: storedAttachmentA,
        mode: "VIEW",
      },
      {
        repository: new AttachmentAccessRepository(db),
        auditRepository: auditRepo,
        signer: { createSignedUrl: async () => ({ url: "https://signed.example/test" }) },
        fetcher: {
          fetchSignedResource: async () => ({
            ok: true,
            status: 200,
            body: streamBody(),
            contentLength: 3,
          }),
        },
      }
    )
    assert.equal(r.kind, "OK")

    const log = await db.acquisitionAttachmentAccessLog.findFirst({
      where: { companyId: companyA, requestedAttachmentId: storedAttachmentA, outcome: "GRANTED" },
      orderBy: { createdAt: "desc" },
    })
    assert.ok(log)
    assert.equal(log!.userId, userA)
    assert.equal(log!.attachmentId, storedAttachmentA)
    assert.equal(log!.action, "VIEW")
  })

  it("audit DENIED cross-tenant sans fuite du tenant réel", async () => {
    const regB = await registerIncomingMessage(
      {
        companyId: companyB,
        source: "GMAIL",
        externalMessageId: `msg-access-b-${Date.now()}`,
        senderEmail: "user@lauralu.fr",
        subject: "tenant b",
        receivedAt: new Date(),
        attachments: [
          {
            externalAttachmentId: "gmail-att-b",
            filename: "b.pdf",
            mimeType: "application/pdf",
            sizeBytes: 50,
          },
        ],
      },
      db
    )
    const attB = await db.acquisitionAttachment.findFirstOrThrow({
      where: { acquisitionMessageId: regB.messageId, companyId: companyB },
    })
    await db.acquisitionAttachment.update({
      where: { id: attB.id },
      data: {
        status: "STORED",
        storagePublicId: "planificator/b/stored.pdf",
        sha256: "bbb",
        storedAt: new Date(),
      },
    })

    const r = await accessAcquisitionAttachment(
      {
        context: { userId: userA, role: "ADMIN", companyId: companyA },
        attachmentId: attB.id,
        mode: "VIEW",
      },
      {
        repository: new AttachmentAccessRepository(db),
        auditRepository: new AttachmentAccessAuditRepository(db),
      }
    )
    assert.equal(r.kind, "NOT_FOUND")

    const denied = await db.acquisitionAttachmentAccessLog.findFirst({
      where: {
        companyId: companyA,
        requestedAttachmentId: attB.id,
        outcome: "DENIED",
      },
      orderBy: { createdAt: "desc" },
    })
    assert.ok(denied)
    assert.equal(denied!.companyId, companyA)
    assert.notEqual(denied!.companyId, companyB)
    assert.equal(denied!.attachmentId, null)
  })

  it("lookup tenant-scopé via repository", async () => {
    const repo = new AttachmentAccessRepository(db)
    const found = await repo.findConsultableAttachment({
      companyId: companyA,
      attachmentId: storedAttachmentA,
    })
    assert.ok(found)
    assert.equal(found!.companyId, companyA)

    const foreign = await repo.findConsultableAttachment({
      companyId: companyB,
      attachmentId: storedAttachmentA,
    })
    assert.equal(foreign, null)
  })

  it("suppression physique attachment référencé par journal GRANTED → rejet FK", async () => {
    const grantedCount = await db.acquisitionAttachmentAccessLog.count({
      where: { attachmentId: storedAttachmentA, outcome: "GRANTED" },
    })
    assert.ok(grantedCount > 0)

    const logBefore = await db.acquisitionAttachmentAccessLog.findFirst({
      where: { attachmentId: storedAttachmentA, outcome: "GRANTED" },
      orderBy: { createdAt: "desc" },
    })
    assert.ok(logBefore)

    await assert.rejects(
      () => db.acquisitionAttachment.delete({ where: { id: storedAttachmentA } }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes("Foreign key constraint") || message.includes("violates foreign key")
      }
    )

    const logAfter = await db.acquisitionAttachmentAccessLog.findUnique({ where: { id: logBefore!.id } })
    assert.ok(logAfter)
    assert.deepEqual(logAfter, logBefore)
  })

  it("log DENIED conserve attachmentId null", async () => {
    const denied = await db.acquisitionAttachmentAccessLog.findFirst({
      where: { companyId: companyA, outcome: "DENIED" },
      orderBy: { createdAt: "desc" },
    })
    assert.ok(denied)
    assert.equal(denied!.attachmentId, null)
    assert.ok(denied!.requestedAttachmentId)
  })
})
