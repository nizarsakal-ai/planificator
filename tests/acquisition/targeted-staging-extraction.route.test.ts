process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  TARGETED_STAGING_EXTRACTION_CHECK_CONFIRMATION,
  TARGETED_STAGING_EXTRACTION_RUN_CONFIRMATION,
  handleTargetedStagingExtraction,
  type TargetedStagingExtractionDraft,
  type TargetedStagingExtractionMailboxProof,
  type TargetedStagingExtractionPlan,
} from "@/lib/acquisition/extraction/targeted-staging-extraction.handler"

const COMPANY_ID = "company_target"
const DRAFT_ID = "draft_target"
const MESSAGE_ID = "message_target"
const ATTACHMENT_ID = "attachment_target"

function baseEnv(): Record<string, string> {
  return {
    VERCEL_ENV: "preview",
    VERCEL_PROJECT_ID: "prj_CRp6XttdXjBjPMjJMSMbsUp6hwVD",
    TARGETED_STAGING_EXTRACTION_ENABLED: "true",
    TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY_ID,
    TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT_ID,
  }
}

function adminAuth() {
  return Promise.resolve({
    user: {
      id: "user_admin",
      role: "ADMIN",
      companyId: COMPANY_ID,
    },
  })
}

function baseDraft(
  over: Partial<TargetedStagingExtractionDraft> = {}
): TargetedStagingExtractionDraft {
  return {
    draftId: DRAFT_ID,
    companyId: COMPANY_ID,
    acquisitionMessageId: MESSAGE_ID,
    status: "PENDING_EXTRACTION",
    extractionAttemptCount: 0,
    version: 1,
    createdWorksiteId: null,
    detectionClassification: "CONSULTATION_UPDATE",
    detectionContentHash: "hash_1",
    ...over,
  }
}

function basePlan(
  over: Partial<TargetedStagingExtractionPlan> = {}
): TargetedStagingExtractionPlan {
  return {
    id: ATTACHMENT_ID,
    companyId: COMPANY_ID,
    acquisitionMessageId: MESSAGE_ID,
    filename: "plan.pdf",
    status: "STORED",
    category: "PLAN",
    hasStoragePublicId: true,
    ...over,
  }
}

function baseMailbox(
  over: Partial<TargetedStagingExtractionMailboxProof> = {}
): TargetedStagingExtractionMailboxProof {
  return {
    messageId: MESSAGE_ID,
    companyId: COMPANY_ID,
    sourceMailboxKey: "nohisac3@gmail.com",
    ...over,
  }
}

function request(body: unknown): Request {
  return new Request(
    "http://localhost/api/acquisition/targeted-staging-extraction",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  )
}

function adminAuthFor(companyId: string | null = COMPANY_ID) {
  return async () => ({
    user: {
      id: "user_admin",
      role: "ADMIN",
      companyId,
    },
  })
}

function baseDeps() {
  return {
    auth: adminAuthFor(),
    env: baseEnv(),
    loadDraft: async () => baseDraft(),
    listPlanCandidates: async () => [basePlan()],
    loadMailboxProof: async () => baseMailbox(),
  }
}

describe("targeted-staging-extraction harness", () => {
  it("flag OFF → refus sans extraction", async () => {
    let runCalls = 0

    const res = await handleTargetedStagingExtraction(
      request({
        confirmation: TARGETED_STAGING_EXTRACTION_CHECK_CONFIRMATION,
    }),
      {
        ...baseDeps(),
        env: {
          ...baseEnv(),
          TARGETED_STAGING_EXTRACTION_ENABLED: "false",
        },
        runExtraction: async () => {
          runCalls += 1
          throw new Error("should not run")
        },
      }
    )

    assert.equal(res.status, 403)
    assert.equal((await res.json()).code, "HARNESS_DISABLED")
    assert.equal(runCalls, 0)
  })

  it("mauvaise confirmation → refus sans extraction", async () => {
    let runCalls = 0

    const res = await handleTargetedStagingExtraction(
      request({ confirmation: "WRONG" }),
      {
        ...baseDeps(),
        runExtraction: async () => {
          runCalls += 1
          throw new Error("should not run")
        },
      }
    )

    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, "CONFIRMATION_REQUIRED")
    assert.equal(runCalls, 0)
  })

  it("override de cible dans le body → refus", async () => {
    let runCalls = 0

    const res = await handleTargetedStagingExtraction(
      request({
        confirmation: TARGETED_STAGING_EXTRACTION_CHECK_CONFIRMATION,
        draftId: "other-draft",
      }),
      {
        ...baseDeps(),
        runExtraction: async () => {
          runCalls += 1
          throw new Error("should not run")
        },
      }
    )

    assert.equal(res.status, 400)
    assert.equal((await res.json()).code, "TARGET_OVERRIDE_FORBIDDEN")
    assert.equal(runCalls, 0)
  })

  it("tenant session différent → refus", async () => {
    let runCalls = 0

    const res = await handleTargetedStagingExtraction(
      request({
        confirmation: TARGETED_STAGING_EXTRACTION_CHECK_CONFIRMATION,
      }),
      {
        ...baseDeps(),
        auth: adminAuthFor("other-company"),
        runExtraction: async () => {
          runCalls += 1
          throw new Error("should not run")
        },
      }
    )

    assert.equal(res.status, 403)
    assert.equal((await res.json()).code, "TENANT_MISMATCH")
    assert.equal(runCalls, 0)
  })

  it("CHECK valide reste read-only", async () => {
    let runCalls = 0
    let draftReads = 0

    const res = await handleTargetedStagingExtraction(
      request({
        confirmation: TARGETED_STAGING_EXTRACTION_CHECK_CONFIRMATION,
      }),
      {
        ...baseDeps(),
        loadDraft: async () => {
          draftReads += 1
          return baseDraft()
        },
        runExtraction: async () => {
          runCalls += 1
          throw new Error("should not run")
        },
      }
    )

    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.mode, "CHECK")
    assert.equal(body.proof.draftPendingExtraction, true)
    assert.equal(body.proof.noCreatedWorksite, true)
    assert.equal(body.proof.uniquePlanPdf, true)
    assert.equal(body.proof.planStored, true)
    assert.equal(body.proof.hasStoragePublicId, true)
    assert.equal(body.proof.sameTenant, true)
    assert.equal(body.proof.sameMessage, true)
    assert.equal(body.proof.mailboxProvenanceExplicit, true)

    assert.equal(draftReads, 1)
    assert.equal(runCalls, 0)
  })

  it("RUN constant is distinct from CHECK constant", () => {
    assert.notEqual(
      TARGETED_STAGING_EXTRACTION_RUN_CONFIRMATION,
      TARGETED_STAGING_EXTRACTION_CHECK_CONFIRMATION
    )
  })

  it("RUN simulé réussi prouve extraction sans création chantier", async () => {
    let runCalls = 0
    let draftReads = 0

    const before = baseDraft({
      status: "PENDING_EXTRACTION",
      extractionAttemptCount: 0,
      version: 3,
      createdWorksiteId: null,
    })

    const after = baseDraft({
      status: "PENDING_REVIEW",
      extractionAttemptCount: 1,
      version: 5,
      createdWorksiteId: null,
    })

    const res = await handleTargetedStagingExtraction(
      request({
        confirmation: TARGETED_STAGING_EXTRACTION_RUN_CONFIRMATION,
      }),
      {
        ...baseDeps(),
        loadDraft: async () => {
          draftReads += 1
          return draftReads === 1 ? before : after
        },
        runExtraction: async () => {
          runCalls += 1
          return {
            ok: true as const,
            outcome: "EXTRACTED" as const,
            draftId: DRAFT_ID,
            status: "PENDING_REVIEW" as const,
            contentHashAtExtraction: "hash_1",
            warningCount: 0,
          }
        },
   }
    )

    assert.equal(res.status, 200)

    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.mode, "RUN")
    assert.equal(body.outcome, "EXTRACTED")
    assert.equal(body.status, "PENDING_REVIEW")
    assert.equal(body.proof.extracted, true)
    assert.equal(body.proof.finalStatusAllowed, true)
    assert.equal(body.proof.attemptIncrementedExactlyOnce, true)
    assert.equal(body.proof.versionAdvanced, true)
    assert.equal(body.proof.noCreatedWorksite, true)
    assert.equal(body.proof.sameTenant, true)
    assert.equal(body.proof.sameDraft, true)
    assert.equal(body.proof.sameMessage, true)
    assert.equal(runCalls, 1)
    assert.equal(draftReads, 2)
  })

  it("RUN simulé échoue si la preuve post-extraction est incomplète", async () => {
    let draftReads = 0

    const before = baseDraft({ extractionAttemptCount: 0, version: 3 })
    const after = baseDraft({
      status: "PENDING_REVIEW",
      extractionAttemptCount: 0,
      version: 5,
      createdWorksiteId: null,
    })

    const res = await handleTargetedStagingExtraction(
      request({ confirmation: TARGETED_STAGING_EXTRACTION_RUN_CONFIRMATION }),
      {
        ...baseDeps(),
        loadDraft: async () => {
          draftReads += 1
          return draftReads === 1 ? before : after
        },
        runExtraction: async () => ({
          ok: true as const,
          outcome: "EXTRACTED" as const,
          draftId: DRAFT_ID,
          status: "PENDING_REVIEW" as const,
          contentHashAtExtraction: "hash_1",
          warningCount: 0,
        }),
      }
    )

    assert.equal(res.status, 409)
    const body = await res.json()
    assert.equal(body.code, "HARNESS_EXTRACTION_PROOF_FAILED")
    assert.equal(body.proof.extracted, true)
    assert.equal(body.proof.attemptIncrementedExactlyOnce, false)
    assert.equal(body.proof.noCreatedWorksite, true)
  })
})
