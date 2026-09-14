process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  ALLOWED_VERCEL_PROJECT_ID,
  FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
  TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION,
  createHarnessBombProvider,
  createHarnessFuseRepository,
  handleTargetedStagingAttachmentNotReady,
  isCompleteAttachmentNotReadyProof,
  isHarnessSurfaceAllowed,
  type HarnessAttachmentRecord,
  type HarnessDraftRecord,
  type HarnessFuseStats,
} from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"
import { runDraftExtractionSystem } from "@/lib/acquisition/extraction/extraction.service"
import type { ExtractDraftResult } from "@/lib/acquisition/extraction/extraction.types"
import type {
  AttachmentMetaRow,
  DraftExtractionRow,
  MessageContentLite,
  MessageLite,
} from "@/lib/acquisition/extraction/extraction.repository"

const COMPANY = "co-harness-1"
const DRAFT = "draft-harness-pending-plan"
const MSG = "msg-1"
const HASH = "hash-abc"

const PREVIEW_ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_ATTACHMENT_NOT_READY_ENABLED: "true",
  TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY,
  TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT,
} as const

const ENV_KEYS = [
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_ENABLED",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID",
  "TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID",
  "NODE_ENV",
  "VERCEL_ENV",
  "VERCEL_PROJECT_ID",
  "PLANIFICATOR_ACQUISITION_ENABLED",
  "ACQUISITION_CONTENT_FETCH_ENABLED",
  "ACQUISITION_EXTRACTION_ENABLED",
  "ACQUISITION_EXTRACTION_PROVIDER",
] as const

function baseDraft(overrides?: Partial<HarnessDraftRecord>): HarnessDraftRecord {
  return {
    draftId: DRAFT,
    companyId: COMPANY,
    status: "PENDING_EXTRACTION",
    extractionAttemptCount: 0,
    version: 3,
    createdWorksiteId: null,
    acquisitionMessageId: MSG,
    ...overrides,
  }
}

function pendingPlanAtt(overrides?: Partial<HarnessAttachmentRecord>): HarnessAttachmentRecord {
  return {
    id: "att-plan-1",
    filename: "plan.pdf",
    mimeType: "application/pdf",
    category: "PLAN",
    status: "DISCOVERED",
    storagePublicId: null,
    ...overrides,
  }
}

function adminAuth(companyId: string | null = COMPANY) {
  return async () => ({
    user: { id: "u1", role: "ADMIN", companyId },
  })
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/acquisition/targeted-staging-attachment-not-ready", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function draftRowFromHarness(d: HarnessDraftRecord): DraftExtractionRow {
  return {
    id: d.draftId,
    companyId: d.companyId,
    acquisitionMessageId: d.acquisitionMessageId,
    status: d.status as DraftExtractionRow["status"],
    version: d.version,
    extractionAttemptCount: d.extractionAttemptCount,
    extractionStartedAt: null,
    contentHashAtExtraction: null,
    extractionSchemaVersion: null,
    detectionClassification: "CONSULTATION",
    detectionContentHash: HASH,
    extractionRetryable: null,
  }
}

function toMeta(att: HarnessAttachmentRecord): AttachmentMetaRow {
  return {
    filename: att.filename,
    mimeType: att.mimeType ?? "",
    category: att.category,
    sizeBytes: 10,
    status: att.status,
    storagePublicId: att.storagePublicId,
  }
}

describe("targeted-staging-attachment-not-ready harness", () => {
  const backup: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) backup[k] = process.env[k]
    process.env.NODE_ENV = "test"
    process.env.VERCEL_ENV = "preview"
    process.env.VERCEL_PROJECT_ID = ALLOWED_VERCEL_PROJECT_ID
    process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_ENABLED = "true"
    process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID = COMPANY
    process.env.TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID = DRAFT
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = backup[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it("Preview du projet exact → autorisé", () => {
    assert.equal(
      isHarnessSurfaceAllowed({
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID,
      }),
      true
    )
  })

  it("Preview autre project ID → refus", () => {
    assert.equal(
      isHarnessSurfaceAllowed({
        VERCEL_ENV: "preview",
        VERCEL_PROJECT_ID: "prj_OTHER",
      }),
      false
    )
  })

  it("Production même project ID → refus", () => {
    assert.equal(
      isHarnessSurfaceAllowed({
        VERCEL_ENV: "production",
        VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID,
      }),
      false
    )
  })

  it("Absence de VERCEL_PROJECT_ID sur Preview → refus", () => {
    assert.equal(isHarnessSurfaceAllowed({ VERCEL_ENV: "preview" }), false)
    assert.equal(isHarnessSurfaceAllowed({ NODE_ENV: "test" }), false)
  })

  it("flag OFF → refus", async () => {
    let calls = 0
    const res = await handleTargetedStagingAttachmentNotReady(
      request({ confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION }),
      {
        env: { ...PREVIEW_ENV, TARGETED_STAGING_ATTACHMENT_NOT_READY_ENABLED: "false" },
        auth: adminAuth(),
        runExtraction: async () => {
          calls += 1
          throw new Error("should not run")
        },
      }
    )
    assert.equal(res.status, 403)
    assert.equal((await res.json()).code, "HARNESS_DISABLED")
    assert.equal(calls, 0)
  })

  it("mauvaise confirmation → refus", async () => {
    let calls = 0
    const res = await handleTargetedStagingAttachmentNotReady(
      request({ confirmation: "WRONG" }),
      {
        env: { ...PREVIEW_ENV },
        auth: adminAuth(),
        runExtraction: async () => {
          calls += 1
          throw new Error("should not run")
        },
      }
    )
    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, "CONFIRMATION_REQUIRED")
    assert.equal(calls, 0)
  })

  it("mauvais draftId body override → refus", async () => {
    let calls = 0
    const res = await handleTargetedStagingAttachmentNotReady(
      request({
        confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION,
        draftId: "other-draft",
      }),
      {
        env: { ...PREVIEW_ENV },
        auth: adminAuth(),
        runExtraction: async () => {
          calls += 1
          throw new Error("should not run")
        },
      }
    )
    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, "TARGET_OVERRIDE_FORBIDDEN")
    assert.equal(calls, 0)
  })

  it("mauvais companyId session → refus", async () => {
    let calls = 0
    const res = await handleTargetedStagingAttachmentNotReady(
      request({ confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION }),
      {
        env: { ...PREVIEW_ENV },
        auth: adminAuth("other-co"),
        runExtraction: async () => {
          calls += 1
          throw new Error("should not run")
        },
      }
    )
    assert.equal(res.status, 403)
    assert.equal((await res.json()).code, "TENANT_MISMATCH")
    assert.equal(calls, 0)
  })

  it("draft non PENDING_EXTRACTION → aucun appel service", async () => {
    let calls = 0
    const res = await handleTargetedStagingAttachmentNotReady(
      request({ confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION }),
      {
        env: { ...PREVIEW_ENV },
        auth: adminAuth(),
        loadDraft: async () => baseDraft({ status: "PENDING_REVIEW" }),
        listAttachments: async () => [pendingPlanAtt()],
        runExtraction: async () => {
          calls += 1
          throw new Error("should not run")
        },
      }
    )
    assert.equal(res.status, 409)
    assert.equal((await res.json()).code, "DRAFT_STATUS_INVALID")
    assert.equal(calls, 0)
  })

  it("aucun PLAN PDF → aucun appel service", async () => {
    let calls = 0
    const res = await handleTargetedStagingAttachmentNotReady(
      request({ confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION }),
      {
        env: { ...PREVIEW_ENV },
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listAttachments: async () => [
          {
            id: "att-other",
            filename: "doc.pdf",
            mimeType: "application/pdf",
            category: "OTHER",
            status: "DISCOVERED",
            storagePublicId: null,
          },
        ],
        runExtraction: async () => {
          calls += 1
          throw new Error("should not run")
        },
      }
    )
    assert.equal(res.status, 409)
    assert.equal((await res.json()).code, "PLAN_PDF_MISSING")
    assert.equal(calls, 0)
  })

  it("draft avec createdWorksiteId → 409 ; extraction non appelée", async () => {
    let calls = 0
    const res = await handleTargetedStagingAttachmentNotReady(
      request({ confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION }),
      {
        env: { ...PREVIEW_ENV },
        auth: adminAuth(),
        loadDraft: async () =>
          baseDraft({ createdWorksiteId: "worksite-existing" }),
        listAttachments: async () => [pendingPlanAtt()],
        runExtraction: async () => {
          calls += 1
          throw new Error("should not run")
        },
      }
    )
    assert.equal(res.status, 409)
    assert.equal((await res.json()).code, "HARNESS_CREATED_WORKSITE_ALREADY_EXISTS")
    assert.equal(calls, 0)
  })

  it("preuve complète avec noCreatedWorksite=false → jamais ok", () => {
    assert.equal(
      isCompleteAttachmentNotReadyProof({
        attachmentNotReady: true,
        statusUnchanged: true,
        attemptCountUnchanged: true,
        createdWorksiteIdUnchanged: true,
        versionUnchanged: true,
        noCreatedWorksite: false,
      }),
      false
    )
    assert.equal(
      isCompleteAttachmentNotReadyProof({
        attachmentNotReady: true,
        statusUnchanged: true,
        attemptCountUnchanged: true,
        createdWorksiteIdUnchanged: true,
        versionUnchanged: true,
        noCreatedWorksite: true,
      }),
      true
    )
  })

  it("PLAN PDF déjà prêt → aucun appel service", async () => {
    let calls = 0
    const res = await handleTargetedStagingAttachmentNotReady(
      request({ confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION }),
      {
        env: { ...PREVIEW_ENV },
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listAttachments: async () => [
          pendingPlanAtt({
            status: "STORED",
            storagePublicId: "acquisition/ready/plan",
          }),
        ],
        runExtraction: async () => {
          calls += 1
          throw new Error("should not run")
        },
      }
    )
    assert.equal(res.status, 409)
    assert.equal((await res.json()).code, "PLAN_PDF_ALREADY_READY")
    assert.equal(calls, 0)
  })

  it("PLAN non prêt stable → ATTACHMENT_NOT_READY ; claim/provider non atteints", async () => {
    const draft = baseDraft()
    const notReady = pendingPlanAtt({ storagePublicId: "   " })
    const stats: HarnessFuseStats = { claimCalls: 0, mutationAttempts: 0, providerCalls: 0 }

    const content: MessageContentLite = {
      normalizedText: "Chantier : Test\nRéférence : REF-1",
      contentHash: HASH,
    }
    const message: MessageLite = {
      id: MSG,
      subject: "Test",
      receivedAt: new Date("2026-01-01"),
    }

    const fuse = createHarnessFuseRepository(
      {
        findDraft: async () => draftRowFromHarness(draft),
        findContent: async () => content,
        findMessage: async () => message,
        listAttachmentMetadata: async () => [toMeta(notReady)],
      },
      stats
    )
    const bomb = createHarnessBombProvider(stats)

    const res = await handleTargetedStagingAttachmentNotReady(
      request({ confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION }),
      {
        env: { ...PREVIEW_ENV },
        auth: adminAuth(),
        loadDraft: async () => draft,
        listAttachments: async () => [notReady],
        runExtraction: async (input) =>
          runDraftExtractionSystem(input, { repository: fuse, provider: bomb }),
      }
    )

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.result.code, "ATTACHMENT_NOT_READY")
    assert.equal(body.proof.attachmentNotReady, true)
    assert.equal(body.proof.versionUnchanged, true)
    assert.equal(body.proof.attemptCountUnchanged, true)
    assert.equal(stats.claimCalls, 0)
    assert.equal(stats.providerCalls, 0)
    assert.equal(stats.mutationAttempts, 0)
    assert.equal(body.before.planAttachment.hasStoragePublicId, false)
    assert.equal(body.before.planAttachment.storagePublicId, undefined)
  })

  it("course simulée → claim fuse null ; provider jamais ; HARNESS_PRECONDITION_RACE", async () => {
    const draft = baseDraft()
    const harnessNotReady = pendingPlanAtt({ status: "DISCOVERED", storagePublicId: null })
    const serviceReady = pendingPlanAtt({
      status: "STORED",
      storagePublicId: "acquisition/race/ready",
    })
    const stats: HarnessFuseStats = { claimCalls: 0, mutationAttempts: 0, providerCalls: 0 }

    const content: MessageContentLite = {
      normalizedText: "Chantier : Race\nRéférence : REF-RACE",
      contentHash: HASH,
    }
    const message: MessageLite = {
      id: MSG,
      subject: "Race",
      receivedAt: new Date("2026-01-01"),
    }

    const fuse = createHarnessFuseRepository(
      {
        findDraft: async () => draftRowFromHarness(draft),
        findContent: async () => content,
        findMessage: async () => message,
        listAttachmentMetadata: async () => [toMeta(serviceReady)],
      },
      stats
    )
    const bomb = createHarnessBombProvider(stats)

    const res = await handleTargetedStagingAttachmentNotReady(
      request({ confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION }),
      {
        env: { ...PREVIEW_ENV },
        auth: adminAuth(),
        loadDraft: async () => draft,
        listAttachments: async () => [harnessNotReady],
        runExtraction: async (input) =>
          runDraftExtractionSystem(input, { repository: fuse, provider: bomb }),
      }
    )

    assert.equal(res.status, 409)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_PRECONDITION_RACE")
    assert.equal(body.result.code, "EXTRACTION_IN_PROGRESS")
    assert.equal(body.proof.attachmentNotReady, false)
    assert.equal(stats.claimCalls, 1)
    assert.equal(stats.providerCalls, 0)
    assert.equal(stats.mutationAttempts, 0)
  })

  it("réponse autre que ATTACHMENT_NOT_READY → pas ok:true", async () => {
    const fake: ExtractDraftResult = {
      ok: false,
      outcome: "FAILED",
      code: "INTERNAL_ERROR",
      message: "boom",
      draftId: DRAFT,
    }
    const res = await handleTargetedStagingAttachmentNotReady(
      request({ confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION }),
      {
        env: { ...PREVIEW_ENV },
        auth: adminAuth(),
        loadDraft: async () => baseDraft(),
        listAttachments: async () => [pendingPlanAtt()],
        runExtraction: async () => fake,
      }
    )
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_PROOF_FAILED")
    assert.equal(body.proof.versionUnchanged, true)
  })

  it("aucune possibilité de fournir librement un autre draftId pour scanner", async () => {
    let loadCalls = 0
    const res = await handleTargetedStagingAttachmentNotReady(
      request({
        confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION,
        draftId: "scan-me-please",
      }),
      {
        env: { ...PREVIEW_ENV },
        auth: adminAuth(),
        loadDraft: async () => {
          loadCalls += 1
          return baseDraft()
        },
        listAttachments: async () => [pendingPlanAtt()],
        runExtraction: async () => {
          throw new Error("should not run")
        },
      }
    )
    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, "TARGET_OVERRIDE_FORBIDDEN")
    assert.equal(loadCalls, 0)
  })

  it("draft GL Events interdit même si env pointe dessus", async () => {
    let calls = 0
    const res = await handleTargetedStagingAttachmentNotReady(
      request({ confirmation: TARGETED_ATTACHMENT_NOT_READY_CONFIRMATION }),
      {
        env: {
          ...PREVIEW_ENV,
          TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: FORBIDDEN_ALREADY_EXTRACTED_DRAFT_ID,
        },
        auth: adminAuth(),
        runExtraction: async () => {
          calls += 1
          throw new Error("should not run")
        },
      }
    )
    assert.equal(res.status, 403)
    assert.equal((await res.json()).code, "FORBIDDEN_DRAFT")
    assert.equal(calls, 0)
  })
})
