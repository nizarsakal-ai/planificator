process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient, type Role } from "@prisma/client"
import { registerIncomingMessage } from "@/lib/acquisition/acquisition.service"
import { AcquisitionAttachmentRepository } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import { runAcquisitionAttachmentDownloadOrchestrator } from "@/lib/acquisition/attachments/attachment-download-orchestrator"
import { downloadAcquisitionAttachment } from "@/lib/acquisition/attachments/attachment-download.service"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

describe("attachment download orchestrator — intégration PostgreSQL", RUN, () => {
  const repo = new AcquisitionAttachmentRepository(db)
  let companyA = ""
  let companyB = ""
  const attachmentIdsA: string[] = []
  let attachmentIdB = ""

  before(async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"

    const a = await db.company.create({
      data: { name: "Orch A", slug: `orch-a-${Date.now()}` },
    })
    const b = await db.company.create({
      data: { name: "Orch B", slug: `orch-b-${Date.now()}` },
    })
    companyA = a.id
    companyB = b.id

    await db.user.create({
      data: {
        email: `orch-${Date.now()}@test.fr`,
        password: "hash",
        role: "ADMIN" as Role,
        companyId: companyA,
      },
    })

    const stamp = Date.now()
    for (let i = 0; i < 3; i++) {
      const reg = await registerIncomingMessage(
        {
          companyId: companyA,
          source: "GMAIL",
          externalMessageId: `orch-msg-a-${stamp}-${i}`,
          senderEmail: "user@lauralu.fr",
          subject: `orch a ${i}`,
          receivedAt: new Date(stamp + i),
          attachments: [
            {
              externalAttachmentId: `gmail-a-${i}`,
              filename: `a${i}.pdf`,
              mimeType: "application/pdf",
              sizeBytes: 10 + i,
            },
          ],
        },
        db
      )
      const att = await db.acquisitionAttachment.findFirstOrThrow({
        where: { acquisitionMessageId: reg.messageId, companyId: companyA },
      })
      attachmentIdsA.push(att.id)
      await db.acquisitionAttachment.update({
        where: { id: att.id },
        data: { createdAt: new Date(stamp + i * 1000) },
      })
    }

    const regB = await registerIncomingMessage(
      {
        companyId: companyB,
        source: "GMAIL",
        externalMessageId: `orch-msg-b-${stamp}`,
        senderEmail: "user@lauralu.fr",
        subject: "orch b",
        receivedAt: new Date(),
        attachments: [
          {
            externalAttachmentId: "gmail-b",
            filename: "b.pdf",
            mimeType: "application/pdf",
            sizeBytes: 20,
          },
        ],
      },
      db
    )
    const attB = await db.acquisitionAttachment.findFirstOrThrow({
      where: { acquisitionMessageId: regB.messageId, companyId: companyB },
    })
    attachmentIdB = attB.id

    // Non-DISCOVERED controls on company A
    await db.acquisitionAttachment.update({
      where: { id: attachmentIdsA[2] },
      data: { status: "STORED", sha256: "x".repeat(64), storagePublicId: "pid/stored", storedAt: new Date() },
    })
  })

  after(async () => {
    await db.company.deleteMany({ where: { id: { in: [companyA, companyB] } } })
    await db.$disconnect()
  })

  it("listCompanyIds ne retourne que tenants avec DISCOVERED", async () => {
    const ids = await repo.listCompanyIdsWithDiscoveredAttachments({ limit: 50 })
    assert.ok(ids.includes(companyA))
    assert.ok(ids.includes(companyB))
  })

  it("maxCompanies respecté", async () => {
    const ids = await repo.listCompanyIdsWithDiscoveredAttachments({ limit: 1 })
    assert.equal(ids.length, 1)
  })

  it("listDiscovered tenant-scopé + FIFO + exclusion autres statuts", async () => {
    const rows = await repo.listDiscoveredAttachmentsForCompany({
      companyId: companyA,
      limit: 10,
    })
    assert.equal(rows.length, 2)
    assert.ok(rows.every((r) => r.companyId === companyA))
    assert.deepEqual(
      rows.map((r) => r.id),
      [attachmentIdsA[0], attachmentIdsA[1]]
    )
    assert.ok(!rows.some((r) => r.id === attachmentIdsA[2]))

    const foreign = await repo.listDiscoveredAttachmentsForCompany({
      companyId: companyB,
      limit: 10,
    })
    assert.equal(foreign.length, 1)
    assert.equal(foreign[0]?.id, attachmentIdB)
  })

  it("orchestrateurs concurrents : un seul téléchargement effectif via claim 004", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"

    // Isolation scénario claim :
    // - une seule PJ DISCOVERED (sinon 2 orchestrateurs maxPerRun=1 téléchargent 2 IDs) ;
    // - repository borné à companyA (sinon le 2e run, après STORED sur A, drain companyB).
    await db.acquisitionAttachment.update({
      where: { id: attachmentIdsA[1] },
      data: { status: "FAILED", lastErrorCode: "ATTACHMENT_FETCH_FAILED" },
    })
    await db.acquisitionAttachment.update({
      where: { id: attachmentIdB },
      data: { status: "FAILED", lastErrorCode: "ATTACHMENT_FETCH_FAILED" },
    })

    const targetId = attachmentIdsA[0]
    const before = await db.acquisitionAttachment.findUniqueOrThrow({ where: { id: targetId } })
    assert.equal(before.status, "DISCOVERED")
    assert.equal(before.companyId, companyA)

    const scopedRepo = {
      listCompanyIdsWithDiscoveredAttachments: async ({ limit }: { limit: number }) => {
        const ids = await repo.listCompanyIdsWithDiscoveredAttachments({ limit })
        return ids.filter((id) => id === companyA).slice(0, limit)
      },
      listDiscoveredAttachmentsForCompany: async (input: {
        companyId: string
        limit: number
      }) => {
        if (input.companyId !== companyA) return []
        return repo.listDiscoveredAttachmentsForCompany(input)
      },
    }

    let gmailCalls = 0
    const downloadedIds: string[] = []
    const download = (input: { companyId: string; attachmentId: string }) => {
      downloadedIds.push(input.attachmentId)
      return downloadAcquisitionAttachment(input, {
        repository: repo,
        gmailSource: {
          fetchAttachment: async () => {
            gmailCalls += 1
            return { data: Buffer.from("%PDF-1.4 concurrent"), sizeBytes: 22 }
          },
        },
        storage: {
          store: async () => ({
            created: true,
            storagePublicId: `pid/${input.attachmentId}`,
            storageUrl: "https://example.invalid/x",
          }),
          destroy: async () => {},
        },
      })
    }

    const [r1, r2] = await Promise.all([
      runAcquisitionAttachmentDownloadOrchestrator({
        repository: scopedRepo,
        downloadAttachment: download,
        createRunId: () => "concurrent-1",
        config: {
          maxPerCompany: 1,
          maxPerRun: 1,
          maxCompaniesPerRun: 1,
          maxDurationMs: 240_000,
        },
      }),
      runAcquisitionAttachmentDownloadOrchestrator({
        repository: scopedRepo,
        downloadAttachment: download,
        createRunId: () => "concurrent-2",
        config: {
          maxPerCompany: 1,
          maxPerRun: 1,
          maxCompaniesPerRun: 1,
          maxDurationMs: 240_000,
        },
      }),
    ])

    assert.ok(downloadedIds.every((id) => id === targetId))
    assert.equal(gmailCalls, 1)

    const after = await db.acquisitionAttachment.findUniqueOrThrow({
      where: { id: targetId, companyId: companyA },
    })
    assert.equal(after.status, "STORED")

    const storedOnTarget = await db.acquisitionAttachment.count({
      where: { id: targetId, companyId: companyA, status: "STORED" },
    })
    assert.equal(storedOnTarget, 1)

    assert.equal(
      r1.globalStats.stored +
        r1.globalStats.alreadyInProgress +
        r1.globalStats.alreadyStored +
        r2.globalStats.stored +
        r2.globalStats.alreadyInProgress +
        r2.globalStats.alreadyStored,
      r1.globalStats.attempted + r2.globalStats.attempted
    )
  })

  it("orchestrateur ne modifie pas FAILED ni PENDING directement", async () => {
    const failedId = attachmentIdsA[1]
    await db.acquisitionAttachment.update({
      where: { id: failedId },
      data: { status: "FAILED", lastErrorCode: "ATTACHMENT_STORAGE_FAILED" },
    })
    const pendingSeed = await registerIncomingMessage(
      {
        companyId: companyA,
        source: "GMAIL",
        externalMessageId: `orch-pending-${Date.now()}`,
        senderEmail: "user@lauralu.fr",
        subject: "pending",
        receivedAt: new Date(),
        attachments: [
          {
            externalAttachmentId: "gmail-pending",
            filename: "p.pdf",
            mimeType: "application/pdf",
            sizeBytes: 5,
          },
        ],
      },
      db
    )
    const pending = await db.acquisitionAttachment.findFirstOrThrow({
      where: { acquisitionMessageId: pendingSeed.messageId, companyId: companyA },
    })
    await db.acquisitionAttachment.update({
      where: { id: pending.id },
      data: { status: "PENDING_DOWNLOAD" },
    })

    const listed = await repo.listDiscoveredAttachmentsForCompany({
      companyId: companyA,
      limit: 50,
    })
    assert.ok(!listed.some((r) => r.id === failedId))
    assert.ok(!listed.some((r) => r.id === pending.id))

    const beforeFailed = await db.acquisitionAttachment.findUniqueOrThrow({ where: { id: failedId } })
    const beforePending = await db.acquisitionAttachment.findUniqueOrThrow({ where: { id: pending.id } })

    await runAcquisitionAttachmentDownloadOrchestrator({
      repository: repo,
      downloadAttachment: async () => ({ outcome: "SKIPPED" }),
      createRunId: () => "no-mutate",
      config: {
        maxPerCompany: 5,
        maxPerRun: 5,
        maxCompaniesPerRun: 5,
        maxDurationMs: 240_000,
      },
    })

    const afterFailed = await db.acquisitionAttachment.findUniqueOrThrow({ where: { id: failedId } })
    const afterPending = await db.acquisitionAttachment.findUniqueOrThrow({ where: { id: pending.id } })
    assert.equal(afterFailed.status, beforeFailed.status)
    assert.equal(afterFailed.lastErrorCode, beforeFailed.lastErrorCode)
    assert.equal(afterPending.status, beforePending.status)
  })
})
