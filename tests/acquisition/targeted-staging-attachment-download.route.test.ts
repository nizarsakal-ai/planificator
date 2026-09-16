process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  TARGETED_ATTACHMENT_DOWNLOAD_CHECK_CONFIRMATION,
  TARGETED_ATTACHMENT_DOWNLOAD_CONFIRMATION,
  handleTargetedStagingAttachmentDownload,
  type TargetedAttachmentDownloadCandidate,
  type TargetedAttachmentDownloadDraft,
  type TargetedAttachmentDownloadScopedRecord,
} from "@/lib/acquisition/attachments/targeted-staging-attachment-download.handler"
import { ALLOWED_VERCEL_PROJECT_ID } from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"
import type { AttachmentDownloadResult } from "@/lib/acquisition/attachments/attachment.types"

const COMPANY = "co-harness-1"
const DRAFT = "draft-harness-pending-plan"
const MSG = "msg-1"
const ATTACHMENT = "att-plan-1"

const PREVIEW_ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_ATTACHMENT_DOWNLOAD_ENABLED: "true",
  TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY,
  TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT,
} as const

function adminAuth(companyId: string | null = COMPANY) {
  return async () => ({
    user: { id: "u1", role: "ADMIN", companyId },
  })
}

function request(body: unknown): Request {
  return new Request(
    "http://localhost/api/acquisition/targeted-staging-attachment-download",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  )
}

function baseDraft(
  overrides?: Partial<TargetedAttachmentDownloadDraft>
): TargetedAttachmentDownloadDraft {
  return {
    draftId: DRAFT,
    companyId: COMPANY,
    acquisitionMessageId: MSG,
    status: "PENDING_EXTRACTION",
    createdWorksiteId: null,
    ...overrides,
  }
}

function planCandidate(
  overrides?: Partial<TargetedAttachmentDownloadCandidate>
): TargetedAttachmentDownloadCandidate {
  return {
    id: ATTACHMENT,
    companyId: COMPANY,
    acquisitionMessageId: MSG,
    filename: "plan.pdf",
    mimeType: "application/pdf",
    category: "PLAN",
    status: "DISCOVERED",
    hasStoragePublicId: false,
    ...overrides,
  }
}

function scopedRecord(
  overrides?: Partial<TargetedAttachmentDownloadScopedRecord["attachment"]>
): TargetedAttachmentDownloadScopedRecord {
  return {
    attachment: {
      id: ATTACHMENT,
      companyId: COMPANY,
      acquisitionMessageId: MSG,
      externalAttachmentId: "gmail-att-1",
      filename: "plan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
      status: "DISCOVERED",
      sha256: null,
      storageUrl: null,
      storagePublicId: null,
      storedAt: null,
      lastErrorCode: null,
      downloadClaimedAt: null,
      downloadRetryCount: 0,
      downloadNextRetryAt: null,
      ...overrides,
    },
    message: {
      id: MSG,
      companyId: COMPANY,
      externalMessageId: "gmail-msg-1",
      sourceMailboxKey: "gmail-connection-explicit",
    },
  }
}

function storedResult(): AttachmentDownloadResult {
  return {
    outcome: "STORED",
    attachmentId: ATTACHMENT,
  }
}

describe("targeted-staging-attachment-download harness", () => {
  it("PLAN unique DISCOVERED + mailbox explicite → téléchargement ciblé prouvé STORED", async () => {
    let downloadCalls = 0
    let readCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          readCalls += 1
          return readCalls === 1
            ? scopedRecord()
            : scopedRecord({
                status: "STORED",
                sha256: "sha256-present",
                storageUrl: "https://storage.test/plan",
                storagePublicId: "storage-public-id-present",
                storedAt: new Date("2026-09-15T12:00:00.000Z"),
              })
        },
        runDownload: async (input) => {
          downloadCalls += 1
          assert.deepEqual(input, {
            companyId: COMPANY,
            attachmentId: ATTACHMENT,
          })
          return storedResult()
        },
      }
    )

    assert.equal(res.status, 200)
    assert.equal(downloadCalls, 1)
    assert.equal(readCalls, 2)

    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.outcome, "STORED")
    assert.deepEqual(body.proof, {
      outcomeStored: true,
      statusStored: true,
      hasSha256: true,
      hasStoragePublicId: true,
      hasStoredAt: true,
      sameTenant: true,
      sameMessage: true,
    })
  })

  it("plusieurs PLAN PDF → ambiguïté refusée avant téléchargement", async () => {
    let downloadCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [
          planCandidate(),
          planCandidate({ id: "att-plan-2", filename: "plan-2.pdf" }),
        ],
        findAttachmentWithMessage: async () => {
          throw new Error("should not read attachment")
        },
        runDownload: async () => {
          downloadCalls += 1
          throw new Error("should not download")
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(downloadCalls, 0)

    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_PLAN_AMBIGUOUS")
    assert.equal(body.candidateCount, 2)
  })

  it("mailbox legacy sans sourceMailboxKey → refus avant téléchargement", async () => {
    let downloadCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => ({
          ...scopedRecord(),
          message: {
            ...scopedRecord().message,
            sourceMailboxKey: "",
          },
        }),
        runDownload: async () => {
          downloadCalls += 1
          throw new Error("should not download")
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(downloadCalls, 0)

    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_MAILBOX_LEGACY_FORBIDDEN")
  })

  it("PLAN unique non DISCOVERED → refus avant téléchargement", async () => {
    let downloadCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [
          planCandidate({
            status: "STORED",
            hasStoragePublicId: true,
          }),
        ],
        findAttachmentWithMessage: async () => {
          throw new Error("should not read attachment")
        },
        runDownload: async () => {
          downloadCalls += 1
          throw new Error("should not download")
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(downloadCalls, 0)

    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_PLAN_PRECONDITION_INVALID")
  })

  it("RUN + PLAN FAILED → refus avant téléchargement", async () => {
    let downloadCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate({ status: "FAILED" })],
        findAttachmentWithMessage: async () => {
          throw new Error("should not read attachment")
        },
        runDownload: async () => {
          downloadCalls += 1
          throw new Error("should not download")
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(downloadCalls, 0)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_PLAN_PRECONDITION_INVALID")
  })

  it("outcome STORED sans preuve DB complète → succès refusé", async () => {
    let downloadCalls = 0
    let readCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          readCalls += 1
          return readCalls === 1
            ? scopedRecord()
            : scopedRecord({
                status: "STORED",
                sha256: "sha256-present",
                storagePublicId: null,
                storedAt: new Date("2026-09-15T12:00:00.000Z"),
              })
        },
        runDownload: async () => {
          downloadCalls += 1
          return storedResult()
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(downloadCalls, 1)
    assert.equal(readCalls, 2)

    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_DOWNLOAD_PROOF_FAILED")
    assert.equal(body.proof.outcomeStored, true)
    assert.equal(body.proof.statusStored, true)
    assert.equal(body.proof.hasSha256, true)
    assert.equal(body.proof.hasStoragePublicId, false)
    assert.equal(body.proof.hasStoredAt, true)
  })

  it("helper baseline", () => {
    assert.equal(baseDraft().status, "PENDING_EXTRACTION")
    assert.equal(planCandidate().status, "DISCOVERED")
    assert.equal(scopedRecord().message.companyId, COMPANY)
    assert.equal(storedResult().outcome, "STORED")
    assert.equal(
      TARGETED_ATTACHMENT_DOWNLOAD_CONFIRMATION,
      "RUN_TARGETED_STAGING_ATTACHMENT_DOWNLOAD"
    )
    assert.equal(
      TARGETED_ATTACHMENT_DOWNLOAD_CHECK_CONFIRMATION,
      "CHECK_TARGETED_STAGING_ATTACHMENT_DOWNLOAD"
    )
    assert.equal(PREVIEW_ENV.VERCEL_ENV, "preview")
    assert.equal(typeof adminAuth, "function")
    assert.equal(typeof request, "function")
    assert.equal(typeof handleTargetedStagingAttachmentDownload, "function")
  })

  it("CHECK happy path → ready true ; runDownload = 0", async () => {
    let downloadCalls = 0
    let readCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CHECK_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          readCalls += 1
          return scopedRecord()
        },
        runDownload: async () => {
          downloadCalls += 1
          throw new Error("should not download")
        },
      }
    )

    assert.equal(res.status, 200)
    assert.equal(downloadCalls, 0)
    assert.equal(readCalls, 1)

    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.harness, "targeted-staging-attachment-download")
    assert.equal(body.mode, "CHECK")
    assert.equal(body.ready, true)
    assert.deepEqual(body.proof, {
      draftPendingExtraction: true,
      noCreatedWorksite: true,
      uniquePlanPdf: true,
      planDiscovered: true,
      planFailed: false,
      storageFailure: false,
      retryScheduled: false,
      retryDue: false,
      retryCount: 0,
      noStoragePublicId: true,
      sameTenant: true,
      sameMessage: true,
      mailboxProvenanceExplicit: true,
    })
  })

  it("CHECK + PLAN FAILED storage + retry échu → diagnostic READ-ONLY ; runDownload = 0", async () => {
    let downloadCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CHECK_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate({ status: "FAILED" })],
        findAttachmentWithMessage: async () =>
          scopedRecord({
            status: "FAILED",
            lastErrorCode: "ATTACHMENT_STORAGE_FAILED",
            downloadRetryCount: 1,
            downloadNextRetryAt: new Date(0),
          }),
        runDownload: async () => {
          downloadCalls += 1
          throw new Error("should not download")
        },
      }
    )

    assert.equal(res.status, 200)
    assert.equal(downloadCalls, 0)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.mode, "CHECK")
    assert.equal(body.ready, true)
    assert.equal(body.proof.planDiscovered, false)
    assert.equal(body.proof.planFailed, true)
    assert.equal(body.proof.storageFailure, true)
    assert.equal(body.proof.retryScheduled, true)
    assert.equal(body.proof.retryDue, true)
    assert.equal(body.proof.retryCount, 1)
  })

  it("CHECK + mailbox legacy vide → HARNESS_MAILBOX_LEGACY_FORBIDDEN ; runDownload = 0", async () => {
    let downloadCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CHECK_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => ({
          ...scopedRecord(),
          message: {
            ...scopedRecord().message,
            sourceMailboxKey: "",
          },
        }),
        runDownload: async () => {
          downloadCalls += 1
          throw new Error("should not download")
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(downloadCalls, 0)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_MAILBOX_LEGACY_FORBIDDEN")
  })

  it("CHECK + plusieurs PLAN PDF → HARNESS_PLAN_AMBIGUOUS ; runDownload = 0", async () => {
    let downloadCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CHECK_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [
          planCandidate(),
          planCandidate({ id: "att-plan-2", filename: "plan-2.pdf" }),
        ],
        findAttachmentWithMessage: async () => {
          throw new Error("should not read attachment")
        },
        runDownload: async () => {
          downloadCalls += 1
          throw new Error("should not download")
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(downloadCalls, 0)
    const body = await res.json()
    assert.equal(body.code, "HARNESS_PLAN_AMBIGUOUS")
  })

  it("CHECK + PLAN STORED → HARNESS_PLAN_PRECONDITION_INVALID ; runDownload = 0", async () => {
    let downloadCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CHECK_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [
          planCandidate({
            status: "STORED",
            hasStoragePublicId: true,
          }),
        ],
        findAttachmentWithMessage: async () => {
          throw new Error("should not read attachment")
        },
        runDownload: async () => {
          downloadCalls += 1
          throw new Error("should not download")
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(downloadCalls, 0)
    const body = await res.json()
    assert.equal(body.code, "HARNESS_PLAN_PRECONDITION_INVALID")
  })

  it("CHECK ne retourne aucun identifiant sensible", async () => {
    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: TARGETED_ATTACHMENT_DOWNLOAD_CHECK_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => scopedRecord(),
        runDownload: async () => {
          throw new Error("should not download")
        },
      }
    )

    assert.equal(res.status, 200)
    const raw = await res.text()
    assert.equal(raw.includes(COMPANY), false)
    assert.equal(raw.includes(DRAFT), false)
    assert.equal(raw.includes(ATTACHMENT), false)
    assert.equal(raw.includes(MSG), false)
    assert.equal(raw.includes("gmail-connection-explicit"), false)
    assert.equal(raw.includes("gmail-msg-1"), false)
    assert.equal(raw.includes("gmail-att-1"), false)
    assert.equal(raw.includes("sourceMailboxKey"), false)
    assert.equal(raw.includes("externalMessageId"), false)
    assert.equal(raw.includes("externalAttachmentId"), false)
    assert.equal(raw.includes('"companyId"'), false)
    assert.equal(raw.includes('"draftId"'), false)
    assert.equal(raw.includes('"attachmentId"'), false)
    assert.equal(raw.includes('"storagePublicId"'), false)
    assert.equal(raw.includes('"storageUrl"'), false)
    assert.equal(raw.includes('"sha256"'), false)
  })

  it("confirmation inconnue → refus ; aucun download", async () => {
    let downloadCalls = 0

    const res = await handleTargetedStagingAttachmentDownload(
      request({ confirmation: "WRONG_CONFIRMATION" }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => {
          throw new Error("should not load draft")
        },
        listPlanCandidates: async () => {
          throw new Error("should not list")
        },
        findAttachmentWithMessage: async () => {
          throw new Error("should not read")
        },
        runDownload: async () => {
          downloadCalls += 1
          throw new Error("should not download")
        },
      }
    )

    assert.equal(res.status, 400)
    assert.equal(downloadCalls, 0)
    const body = await res.json()
    assert.equal(body.code, "CONFIRMATION_REQUIRED")
  })
})
