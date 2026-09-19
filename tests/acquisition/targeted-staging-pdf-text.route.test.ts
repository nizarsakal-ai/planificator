process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  TARGETED_STAGING_PDF_TEXT_CHECK_CONFIRMATION,
  TARGETED_STAGING_PDF_TEXT_RUN_CONFIRMATION,
  handleTargetedStagingPdfText,
  type TargetedStagingPdfTextDraft,
  type TargetedStagingPdfTextMailbox,
  type TargetedStagingPdfTextPlan,
} from "@/lib/acquisition/extraction/targeted-staging-pdf-text.handler"
import { ALLOWED_VERCEL_PROJECT_ID } from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"

const COMPANY = "co-pdf-text"
const DRAFT = "draft-pdf-text"
const MSG = "msg-pdf-text"
const ATTACHMENT = "att-pdf-text"

const PREVIEW_ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_PDF_TEXT_ENABLED: "true",
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
    "http://localhost/api/acquisition/targeted-staging-pdf-text",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  )
}

function draft(
  overrides?: Partial<TargetedStagingPdfTextDraft>
): TargetedStagingPdfTextDraft {
  return {
    draftId: DRAFT,
    companyId: COMPANY,
    acquisitionMessageId: MSG,
    status: "PENDING_REVIEW",
    createdWorksiteId: null,
    ...overrides,
  }
}

function plan(
  overrides?: Partial<TargetedStagingPdfTextPlan>
): TargetedStagingPdfTextPlan {
  return {
    id: ATTACHMENT,
    companyId: COMPANY,
    acquisitionMessageId: MSG,
    filename: "plan.pdf",
    mimeType: "application/pdf",
    category: "PLAN",
    status: "STORED",
    storagePublicId: "storage-public-id",
    ...overrides,
  }
}

function mailbox(
  overrides?: Partial<TargetedStagingPdfTextMailbox>
): TargetedStagingPdfTextMailbox {
  return {
    messageId: MSG,
    companyId: COMPANY,
    sourceMailboxKey: "gmail-connection-explicit",
    ...overrides,
  }
}

describe("targeted-staging-pdf-text harness", () => {
  it("CHECK happy path → ready true ; aucun téléchargement", async () => {
    let loadBytesCalls = 0
    let extractCalls = 0

    const res = await handleTargetedStagingPdfText(
      request({ confirmation: TARGETED_STAGING_PDF_TEXT_CHECK_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => draft(),
        listPlanCandidates: async () => [plan()],
        loadMailbox: async () => mailbox(),
        loadBytes: async () => {
          loadBytesCalls += 1
          throw new Error("should not load bytes")
        },
        extractText: async () => {
          extractCalls += 1
          throw new Error("should not extract")
        },
      }
    )

    assert.equal(res.status, 200)
    assert.equal(loadBytesCalls, 0)
    assert.equal(extractCalls, 0)

    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.mode, "CHECK")
    assert.equal(body.ready, true)
    assert.deepEqual(body.proof, {
      draftPendingReview: true,
      noCreatedWorksite: true,
      uniquePlanPdf: true,
      planStored: true,
      hasStoragePublicId: true,
      sameTenant: true,
      sameMessage: true,
      mailboxProvenanceExplicit: true,
    })
  })

  it("RUN happy path → texte PDF retourné", async () => {
    let loadBytesCalls = 0
    let extractCalls = 0

    const res = await handleTargetedStagingPdfText(
      request({ confirmation: TARGETED_STAGING_PDF_TEXT_RUN_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => draft(),
        listPlanCandidates: async () => [plan()],
        loadMailbox: async () => mailbox(),
        loadBytes: async (input) => {
          loadBytesCalls += 1
          assert.equal(input.filename, "plan.pdf")
          assert.equal(input.status, "STORED")
          assert.equal(input.storagePublicId, "storage-public-id")
          return Buffer.from("%PDF-test")
        },
        extractText: async (_bytes, opts) => {
          extractCalls += 1
          assert.equal(opts?.maxChars, 8_000)
          assert.equal(opts?.timeoutMs, 3_000)
          assert.equal(opts?.maxBytes, 10 * 1024 * 1024)
          return {
            status: "PDF_TEXT_EXTRACTED",
            text: "Intervention le 11/09/2026",
            truncated: false,
          }
        },
      }
    )

    assert.equal(res.status, 200)
    assert.equal(loadBytesCalls, 1)
    assert.equal(extractCalls, 1)

    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.mode, "RUN")
    assert.equal(body.status, "PDF_TEXT_EXTRACTED")
    assert.equal(body.truncated, false)
    assert.equal(body.text, "Intervention le 11/09/2026")
  })

  it("flag dédié OFF → refus avant lecture", async () => {
    let loadBytesCalls = 0

    const res = await handleTargetedStagingPdfText(
      request({ confirmation: TARGETED_STAGING_PDF_TEXT_CHECK_CONFIRMATION }),
      {
        env: {
          ...PREVIEW_ENV,
          TARGETED_STAGING_PDF_TEXT_ENABLED: "false",
        },
        auth: adminAuth(),
        loadDraft: async () => {
          throw new Error("should not load draft")
        },
        listPlanCandidates: async () => {
          throw new Error("should not list plans")
        },
        loadMailbox: async () => {
          throw new Error("should not load mailbox")
        },
        loadBytes: async () => {
          loadBytesCalls += 1
          throw new Error("should not load bytes")
        },
      }
    )

    assert.equal(res.status, 403)
    assert.equal(loadBytesCalls, 0)
    const body = await res.json()
    assert.equal(body.code, "HARNESS_DISABLED")
  })

  it("confirmation inconnue → refus avant lecture", async () => {
    let loadBytesCalls = 0

    const res = await handleTargetedStagingPdfText(
      request({ confirmation: "WRONG_CONFIRMATION" }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => {
          throw new Error("should not load draft")
        },
        listPlanCandidates: async () => {
          throw new Error("should not list plans")
        },
        loadMailbox: async () => {
          throw new Error("should not load mailbox")
        },
        loadBytes: async () => {
          loadBytesCalls += 1
          throw new Error("should not load bytes")
        },
      }
    )

    assert.equal(res.status, 400)
    assert.equal(loadBytesCalls, 0)
    const body = await res.json()
    assert.equal(body.code, "CONFIRMATION_REQUIRED")
  })

  it("tenant mismatch → refus avant lecture", async () => {
    let loadBytesCalls = 0

    const res = await handleTargetedStagingPdfText(
      request({ confirmation: TARGETED_STAGING_PDF_TEXT_CHECK_CONFIRMATION }),
      {
      env: PREVIEW_ENV,
        auth: adminAuth("other-company"),
        loadDraft: async () => {
          throw new Error("should not load draft")
        },
        listPlanCandidates: async () => {
          throw new Error("should not list plans")
        },
        loadMailbox: async () => {
          throw new Error("should not load mailbox")
        },
        loadBytes: async () => {
          loadBytesCalls += 1
          throw new Error("should not load bytes")
        },
      }
    )

    assert.equal(res.status, 403)
    assert.equal(loadBytesCalls, 0)
    const body = await res.json()
    assert.equal(body.code, "TENANT_MISMATCH")
  })

  it("PLAN non STORED → refus avant lecture", async () => {
    let loadBytesCalls = 0

    const res = await handleTargetedStagingPdfText(
      request({ confirmation: TARGETED_STAGING_PDF_TEXT_RUN_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => draft(),
        listPlanCandidates: async () => [
        plan({
            status: "DISCOVERED",
            storagePublicId: null,
          }),
        ],
        loadMailbox: async () => mailbox(),
        loadBytes: async () => {
          loadBytesCalls += 1
          throw new Error("should not load bytes")
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(loadBytesCalls, 0)
    const body = await res.json()
    assert.equal(body.code, "HARNESS_PLAN_PRECONDITION_INVALID")
  })

  it("mailbox legacy → refus avant lecture", async () => {
    let loadBytesCalls = 0

    const res = await handleTargetedStagingPdfText(
      request({ confirmation: TARGETED_STAGING_PDF_TEXT_RUN_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => draft(),
        listPlanCandidates: async () => [plan()],
        loadMailbox: async () => mailbox({ sourceMailboxKey: "" }),
        loadBytes: async () => {
          loadBytesCalls += 1
          throw new Error("should not load bytes")
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(loadBytesCalls, 0)
    const body = await res.json()
    assert.equal(body.code, "HARNESS_MAILBOX_LEGACY_FORBIDDEN")
  })

  it("CHECK ne retourne aucun identifiant sensible", async () => {
    const res = await handleTargetedStagingPdfText(
      request({ confirmation: TARGETED_STAGING_PDF_TEXT_CHECK_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => draft(),
        listPlanCandidates: async () => [plan()],
        loadMailbox: async () => mailbox(),
      }
    )

    assert.equal(res.status, 200)
    const raw = await res.text()
    assert.equal(raw.includes(COMPANY), false)
    assert.equal(raw.includes(DRAFT), false)
    assert.equal(raw.includes(MSG), false)
    assert.equal(raw.includes(ATTACHMENT), false)
    assert.equal(raw.includes("storage-public-id"), false)
    assert.equal(raw.includes("gmail-connection-explicit"), false)
    assert.equal(raw.includes('"companyId"'), false)
    assert.equal(raw.includes('"draftId"'), false)
    assert.equal(raw.includes('"attachmentId"'), false)
    assert.equal(raw.includes('"storagePublicId"'), false)
  })

  it("identifiant de cible dans le body → refus avant lecture", async () => {
    const res = await handleTargetedStagingPdfText(
      request({
        confirmation: TARGETED_STAGING_PDF_TEXT_CHECK_CONFIRMATION,
        draftId: "attempted-override",
      }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        loadDraft: async () => {
          throw new Error("should not load draft")
        },
      }
    )

    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.code, "TARGET_OVERRIDE_FORBIDDEN")
  })
})
