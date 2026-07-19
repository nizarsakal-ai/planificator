process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { downloadAcquisitionAttachment } from "@/lib/acquisition/attachments/attachment-download.service"
import type { AcquisitionAttachmentRepositoryPort } from "@/lib/acquisition/attachments/acquisition-attachment.repository"
import type { GmailAttachmentSourcePort } from "@/lib/acquisition/attachments/gmail-attachment-source.adapter"
import type { AttachmentStoragePort } from "@/lib/acquisition/attachments/attachment-storage.port"
import type {
  AttachmentFailureUpdate,
  AttachmentMessageContext,
  AttachmentRecord,
  ClaimForDownloadResult,
  MarkStoredResult,
  StoredAttachmentUpdate,
} from "@/lib/acquisition/attachments/attachment.types"

const PDF_BUFFER = Buffer.from("%PDF-1.4 test")

function baseAttachment(overrides: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: "att-1",
    companyId: "co-1",
    acquisitionMessageId: "msg-1",
    externalAttachmentId: "gmail-att-1",
    filename: "plan.pdf",
    mimeType: "application/pdf",
    sizeBytes: PDF_BUFFER.length,
    status: "DISCOVERED",
    sha256: null,
    storageUrl: null,
    storagePublicId: null,
    storedAt: null,
    lastErrorCode: null,
    ...overrides,
  }
}

function baseMessage(): AttachmentMessageContext {
  return { id: "msg-1", companyId: "co-1", externalMessageId: "ext-msg-1" }
}

function claimedRepo(overrides: Partial<AcquisitionAttachmentRepositoryPort> = {}): AcquisitionAttachmentRepositoryPort {
  const attachment = baseAttachment()
  const message = baseMessage()
  return {
    findAttachmentWithMessage:
      overrides.findAttachmentWithMessage ?? (async () => ({ attachment, message })),
    claimForDownload:
      overrides.claimForDownload ??
      (async () => ({ status: "CLAIMED", attachment } satisfies ClaimForDownloadResult)),
    markStored:
      overrides.markStored ??
      (async (_c, _a, update) =>
        ({ status: "STORED", attachment: baseAttachment({ status: "STORED", sha256: update.sha256, storagePublicId: update.storagePublicId }) } satisfies MarkStoredResult)),
    markFailure:
      overrides.markFailure ??
      (async (_c, _a, update: AttachmentFailureUpdate) =>
        baseAttachment({ status: update.status, lastErrorCode: update.errorCode })),
    listCompanyIdsWithDiscoveredAttachments:
      overrides.listCompanyIdsWithDiscoveredAttachments ?? (async () => []),
    listDiscoveredAttachmentsForCompany:
      overrides.listDiscoveredAttachmentsForCompany ?? (async () => []),
  }
}

describe("attachment-download.service", () => {
  const envBackup = {
    acquisition: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    download: process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED,
    maxBytes: process.env.ACQUISITION_ATTACHMENT_MAX_BYTES,
  }

  beforeEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    delete process.env.ACQUISITION_ATTACHMENT_MAX_BYTES
  })

  afterEach(() => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.acquisition
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = envBackup.download
    if (envBackup.maxBytes === undefined) delete process.env.ACQUISITION_ATTACHMENT_MAX_BYTES
    else process.env.ACQUISITION_ATTACHMENT_MAX_BYTES = envBackup.maxBytes
  })

  it("skip si feature flag désactivé", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "false"
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      { repository: claimedRepo(), gmailSource: mockGmail({}), storage: mockStorage({}) }
    )
    assert.equal(r.outcome, "SKIPPED")
  })

  it("retourne ALREADY_STORED via claim", async () => {
    const attachment = baseAttachment({
      status: "STORED",
      sha256: "abc",
      storagePublicId: "pid",
      storedAt: new Date("2026-01-01"),
    })
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      {
        repository: claimedRepo({
          claimForDownload: async () => ({ status: "ALREADY_STORED", attachment }),
        }),
        gmailSource: mockGmail({}),
        storage: mockStorage({}),
      }
    )
    assert.equal(r.outcome, "ALREADY_STORED")
  })

  it("retourne ALREADY_IN_PROGRESS si claim concurrent", async () => {
    const gmailCalls: unknown[] = []
    const storeCalls: unknown[] = []
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      {
        repository: claimedRepo({
          claimForDownload: async () => ({ status: "ALREADY_IN_PROGRESS" }),
        }),
        gmailSource: mockGmail({ fetchAttachment: async () => { gmailCalls.push(1); return { data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length } } }),
        storage: mockStorage({ store: async (input) => { storeCalls.push(input); return { storageUrl: "u", storagePublicId: "p", created: true } } }),
      }
    )
    assert.equal(r.outcome, "ALREADY_IN_PROGRESS")
    assert.equal(gmailCalls.length, 0)
    assert.equal(storeCalls.length, 0)
  })

  it("FAILED non automatiquement retraité", async () => {
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      {
        repository: claimedRepo({
          claimForDownload: async () => ({
            status: "NOT_RETRYABLE",
            attachment: baseAttachment({ status: "FAILED", lastErrorCode: "GMAIL_ATTACHMENT_NOT_FOUND" }),
          }),
        }),
        gmailSource: mockGmail({}),
        storage: mockStorage({}),
      }
    )
    assert.equal(r.outcome, "FAILED")
    assert.equal(r.errorCode, "GMAIL_ATTACHMENT_NOT_FOUND")
  })

  it("REJECTED non automatiquement retraité", async () => {
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      {
        repository: claimedRepo({
          claimForDownload: async () => ({
            status: "NOT_RETRYABLE",
            attachment: baseAttachment({ status: "REJECTED" }),
          }),
        }),
        gmailSource: mockGmail({}),
        storage: mockStorage({}),
      }
    )
    assert.equal(r.outcome, "REJECTED")
  })

  it("stocke un PDF valide", async () => {
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      {
        repository: claimedRepo(),
        gmailSource: mockGmail({
          fetchAttachment: async () => ({ data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length }),
        }),
        storage: mockStorage({
          store: async () => ({ storageUrl: "https://cloudinary.test/file", storagePublicId: "pid", created: true }),
        }),
        log: () => {},
      }
    )
    assert.equal(r.outcome, "STORED")
    assert.ok(r.sha256)
  })

  it("hash calculé avant store sur le même Buffer", async () => {
    let storedBuffer: Buffer | null = null
    let hashBeforeStore: string | null = null
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      {
        repository: claimedRepo(),
        gmailSource: mockGmail({
          fetchAttachment: async () => ({ data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length }),
        }),
        storage: mockStorage({
          store: async (input) => {
            hashBeforeStore = createHash("sha256").update(PDF_BUFFER).digest("hex")
            storedBuffer = input.buffer
            return { storageUrl: "u", storagePublicId: "pid", created: true }
          },
        }),
        log: () => {},
      }
    )
    assert.equal(r.outcome, "STORED")
    assert.equal(r.sha256, hashBeforeStore)
    assert.deepEqual(storedBuffer, PDF_BUFFER)
  })

  it("upload OK + markStored KO + destroy OK", async () => {
    const destroyCalls: string[] = []
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      {
        repository: claimedRepo({
          markStored: async () => ({ status: "FAILED" }),
        }),
        gmailSource: mockGmail({
          fetchAttachment: async () => ({ data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length }),
        }),
        storage: mockStorage({
          store: async () => ({ storageUrl: "u", storagePublicId: "pid-123", created: true }),
          destroy: async (input) => {
            destroyCalls.push(input.storagePublicId)
          },
        }),
        log: () => {},
      }
    )
    assert.equal(r.outcome, "FAILED")
    assert.equal(r.errorCode, "ATTACHMENT_PERSISTENCE_FAILED")
    assert.deepEqual(destroyCalls, ["pid-123"])
  })

  it("upload OK + markStored KO + destroy KO : erreur principale préservée", async () => {
    const logs: string[] = []
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      {
        repository: claimedRepo({
          markStored: async () => ({ status: "FAILED" }),
        }),
        gmailSource: mockGmail({
          fetchAttachment: async () => ({ data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length }),
        }),
        storage: mockStorage({
          store: async () => ({ storageUrl: "u", storagePublicId: "pid-123", created: true }),
          destroy: async () => {
            throw new Error("ATTACHMENT_COMPENSATION_FAILED")
          },
        }),
        log: (_e, payload) => logs.push(JSON.stringify(payload ?? {})),
      }
    )
    assert.equal(r.errorCode, "ATTACHMENT_PERSISTENCE_FAILED")
    assert.ok(logs.some((l) => l.includes("ATTACHMENT_COMPENSATION_FAILED")))
    assert.ok(!JSON.stringify(r).includes("ATTACHMENT_COMPENSATION_FAILED"))
  })

  it("store objet déjà existant : markStored jamais appelé", async () => {
    let markStoredCalls = 0
    const destroyCalls: string[] = []
    const failureUpdates: AttachmentFailureUpdate[] = []
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      {
        repository: claimedRepo({
          markStored: async () => {
            markStoredCalls += 1
            return { status: "FAILED" }
          },
          markFailure: async (_c, _a, update) => {
            failureUpdates.push(update)
            return baseAttachment({ status: update.status, lastErrorCode: update.errorCode })
          },
        }),
        gmailSource: mockGmail({
          fetchAttachment: async () => ({ data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length }),
        }),
        storage: mockStorage({
          store: async () => ({
            storagePublicId: "pid-existing",
            created: false,
          }),
          destroy: async (input) => {
            destroyCalls.push(input.storagePublicId)
          },
        }),
        log: () => {},
      }
    )
    assert.equal(r.outcome, "FAILED")
    assert.equal(r.errorCode, "ATTACHMENT_STORAGE_COLLISION")
    assert.equal(markStoredCalls, 0)
    assert.deepEqual(destroyCalls, [])
    assert.equal(failureUpdates.length, 1)
    assert.equal(failureUpdates[0]?.errorCode, "ATTACHMENT_STORAGE_COLLISION")
    assert.notEqual(r.outcome, "ALREADY_STORED")
  })

  it("created:false : storageUrl et storagePublicId non persistés via markStored", async () => {
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      {
        repository: claimedRepo({
          markStored: async () => {
            throw new Error("markStored ne doit pas être appelé")
          },
        }),
        gmailSource: mockGmail({
          fetchAttachment: async () => ({ data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length }),
        }),
        storage: mockStorage({
          store: async () => ({ storagePublicId: "pid-existing", created: false }),
        }),
        log: () => {},
      }
    )
    assert.equal(r.errorCode, "ATTACHMENT_STORAGE_COLLISION")
    assert.equal(r.storagePublicId, undefined)
  })

  it("second worker ne détruit jamais l'objet du premier (created:false)", async () => {
    const sharedPublicId = "planificator/co-1/acquisition/msg-1/att-1/file"
    const destroyCalls: string[] = []
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-1", attachmentId: "att-1" },
      {
        repository: claimedRepo({
          markStored: async () => {
            throw new Error("markStored ne doit pas être appelé")
          },
        }),
        gmailSource: mockGmail({
          fetchAttachment: async () => ({ data: PDF_BUFFER, sizeBytes: PDF_BUFFER.length }),
        }),
        storage: mockStorage({
          store: async () => ({
            storagePublicId: sharedPublicId,
            created: false,
          }),
          destroy: async (input) => {
            destroyCalls.push(input.storagePublicId)
          },
        }),
        log: () => {},
      }
    )
    assert.equal(r.errorCode, "ATTACHMENT_STORAGE_COLLISION")
    assert.deepEqual(destroyCalls, [])
  })

  it("tenant croisé refusé", async () => {
    const r = await downloadAcquisitionAttachment(
      { companyId: "co-A", attachmentId: "att-1" },
      {
        repository: claimedRepo({
          findAttachmentWithMessage: async () => null,
        }),
        gmailSource: mockGmail({}),
        storage: mockStorage({}),
      }
    )
    assert.equal(r.errorCode, "ATTACHMENT_NOT_FOUND")
  })
})

function mockGmail(impl: Partial<GmailAttachmentSourcePort>): GmailAttachmentSourcePort {
  return {
    fetchAttachment:
      impl.fetchAttachment ??
      (async () => {
        throw new Error("GMAIL_ATTACHMENT_NOT_FOUND")
      }),
  }
}

function mockStorage(impl: Partial<AttachmentStoragePort>): AttachmentStoragePort {
  return {
    store:
      impl.store ??
      (async () => {
        throw new Error("ATTACHMENT_STORAGE_FAILED")
      }),
    destroy:
      impl.destroy ??
      (async () => {
        /* noop */
      }),
  }
}
