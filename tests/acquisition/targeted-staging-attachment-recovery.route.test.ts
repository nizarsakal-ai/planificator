process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  TARGETED_ATTACHMENT_RECOVERY_CHECK_CONFIRMATION,
  TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION,
  handleTargetedStagingAttachmentRecovery,
  type TargetedAttachmentRecoveryCandidate,
  type TargetedAttachmentRecoveryDraft,
  type TargetedAttachmentRecoveryScopedRecord,
} from "@/lib/acquisition/attachments/targeted-staging-attachment-recovery.handler"
import {
  ALLOWED_VERCEL_PROJECT_ID,
} from "@/lib/acquisition/extraction/targeted-staging-attachment-not-ready.handler"
import {
  DEFAULT_RECLAIM_TTL_MS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DEFAULT_RECOVERY_MAX_COMPANIES_PER_RUN,
  DEFAULT_RECOVERY_MAX_DURATION_MS,
  DEFAULT_RECOVERY_MAX_PER_COMPANY,
  DEFAULT_RECOVERY_MAX_PER_RUN,
  DEFAULT_RETRY_MAX_RETRIES,
  type AttachmentRecoveryCronConfig,
} from "@/lib/acquisition/attachments/attachment-recovery-cron-feature-flag"

const COMPANY = "co-harness-1"
const DRAFT = "draft-harness-pending-plan"
const MSG = "msg-1"
const ATTACHMENT = "att-plan-1"
const NOW = new Date("2026-09-16T18:00:00.000Z")

const PREVIEW_ENV = {
  VERCEL_ENV: "preview",
  VERCEL_PROJECT_ID: ALLOWED_VERCEL_PROJECT_ID,
  TARGETED_STAGING_ATTACHMENT_RECOVERY_ENABLED: "true",
  TARGETED_STAGING_ATTACHMENT_NOT_READY_COMPANY_ID: COMPANY,
  TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: DRAFT,
} as const

function recoveryConfig(): AttachmentRecoveryCronConfig {
  return {
    reclaimTtlMs: DEFAULT_RECLAIM_TTL_MS,
    maxRetries: DEFAULT_RETRY_MAX_RETRIES,
    baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
    maxPerCompany: DEFAULT_RECOVERY_MAX_PER_COMPANY,
    maxPerRun: DEFAULT_RECOVERY_MAX_PER_RUN,
    maxCompaniesPerRun: DEFAULT_RECOVERY_MAX_COMPANIES_PER_RUN,
    maxDurationMs: DEFAULT_RECOVERY_MAX_DURATION_MS,
  }
}

function adminAuth(companyId: string | null = COMPANY) {
  return async () => ({
    user: { id: "u1", role: "ADMIN", companyId },
  })
}

function request(body: unknown): Request {
  return new Request(
    "http://localhost/api/acquisition/targeted-staging-attachment-recovery",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  )
}

function baseDraft(
  overrides?: Partial<TargetedAttachmentRecoveryDraft>
): TargetedAttachmentRecoveryDraft {
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
  overrides?: Partial<TargetedAttachmentRecoveryCandidate>
): TargetedAttachmentRecoveryCandidate {
  return {
    id: ATTACHMENT,
    companyId: COMPANY,
    acquisitionMessageId: MSG,
    filename: "plan.pdf",
    mimeType: "application/pdf",
    category: "PLAN",
    status: "FAILED",
    hasStoragePublicId: false,
    ...overrides,
  }
}

function scopedRecord(
  overrides?: Partial<TargetedAttachmentRecoveryScopedRecord["attachment"]>
): TargetedAttachmentRecoveryScopedRecord {
  return {
    attachment: {
      id: ATTACHMENT,
      companyId: COMPANY,
      acquisitionMessageId: MSG,
      externalAttachmentId: "gmail-att-1",
      filename: "plan.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
      status: "FAILED",
      sha256: null,
      storageUrl: null,
      storagePublicId: null,
      storedAt: null,
      lastErrorCode: "ATTACHMENT_STORAGE_FAILED",
      downloadClaimedAt: null,
      downloadRetryCount: 1,
      downloadNextRetryAt: new Date("2026-09-16T17:00:00.000Z"),
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

describe("targeted-staging-attachment-recovery harness", () => {
  it("CHECK FAILED retryable et dû → prêt sans mutation", async () => {
    let scheduleCalls = 0
    let readCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CHECK_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          readCalls += 1
          return scopedRecord()
        },
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 200)
    assert.equal(scheduleCalls, 0)
    assert.equal(readCalls, 1)

    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.mode, "CHECK")
    assert.equal(body.ready, true)
    assert.deepEqual(body.proof, {
      draftPendingExtraction: true,
      noCreatedWorksite: true,
      uniquePlanPdf: true,
      planFailed: true,
      retryableError: true,
      retryScheduled: true,
      retryDue: true,
      retryWithinLimit: true,
      retryCount: 1,
      noStoragePublicId: true,
      sameTenant: true,
      sameMessage: true,
      mailboxProvenanceExplicit: true,
    })
  })

  it("RUN FAILED retryable et dû → transition atomique unique puis preuve DISCOVERED", async () => {
    let scheduleCalls = 0
    let readCalls = 0
    let draftCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => {
          draftCalls += 1
          return baseDraft()
        },
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          readCalls += 1
          return readCalls === 1
            ? scopedRecord()
            : scopedRecord({
                status: "DISCOVERED",
                downloadClaimedAt: null,
                downloadNextRetryAt: null,
              })
        },
        scheduleRetryToDiscovered: async (input) => {
          scheduleCalls += 1
          assert.equal(input.companyId, COMPANY)
          assert.equal(input.attachmentId, ATTACHMENT)
          assert.equal(input.now, NOW)
          assert.equal(input.maxRetries, DEFAULT_RETRY_MAX_RETRIES)
          assert.ok(input.retryableErrorCodes.includes("ATTACHMENT_STORAGE_FAILED"))
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 200)
    assert.equal(scheduleCalls, 1)
    assert.equal(readCalls, 2)
    assert.equal(draftCalls, 2)

    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.mode, "RUN")
    assert.equal(body.outcome, "TRANSITIONED")
    assert.deepEqual(body.proof, {
      transitioned: true,
      statusDiscovered: true,
      retryScheduleCleared: true,
      claimCleared: true,
      retryCountUnchanged: true,
      noStoragePublicId: true,
      sameTenant: true,
      sameMessage: true,
      sameDraft: true,
      mailboxProvenanceExplicit: true,
      draftStillPendingExtraction: true,
      noCreatedWorksite: true,
    })
  })

  it("RUN transition NOOP → refus fail-closed sans seconde mutation", async () => {
    let scheduleCalls = 0
    let readCalls = 0
    let draftCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => {
          draftCalls += 1
          return baseDraft()
        },
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          readCalls += 1
          return scopedRecord()
        },
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "NOOP"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 1)
    assert.equal(readCalls, 1)
    assert.equal(draftCalls, 1)

    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_RECOVERY_TRANSITION_NOOP")
    assert.equal(body.transitioned, false)
  })

  it("erreur non retryable → refus avant toute transition", async () => {
    let scheduleCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () =>
          scopedRecord({ lastErrorCode: "ATTACHMENT_TOO_LARGE" }),
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 0)

    const body = await res.json()
    assert.equal(body.ok, false)
  })

  it("retry planifié mais pas encore dû → refus avant toute transition", async () => {
    let scheduleCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () =>
          scopedRecord({
            downloadNextRetryAt: new Date("2026-09-16T19:00:00.000Z"),
          }),
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 0)

    const body = await res.json()
    assert.equal(body.ok, false)
  })

  it("retryCount supérieur à maxRetries → refus avant toute transition", async () => {
    let scheduleCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () =>
          scopedRecord({
            downloadRetryCount: DEFAULT_RETRY_MAX_RETRIES + 1,
          }),
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 0)

    const body = await res.json()
    assert.equal(body.ok, false)
  })

  it("retryCount égal à maxRetries → CHECK autorisé sans mutation", async () => {
    let scheduleCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CHECK_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () =>
          scopedRecord({
            downloadRetryCount: DEFAULT_RETRY_MAX_RETRIES,
          }),
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 200)
    assert.equal(scheduleCalls, 0)

    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.ready, true)
    assert.equal(body.proof.retryWithinLimit, true)
    assert.equal(body.proof.retryCount, DEFAULT_RETRY_MAX_RETRIES)
  })

  it("plusieurs PLAN PDF → ambiguïté refusée avant lecture ciblée et transition", async () => {
    let readCalls = 0
    let scheduleCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [
          planCandidate(),
          planCandidate({ id: "att-plan-2", filename: "plan-2.pdf" }),
        ],
        findAttachmentWithMessage: async () => {
          readCalls += 1
          return scopedRecord()
        },
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(readCalls, 0)
    assert.equal(scheduleCalls, 0)

    const body = await res.json()
    assert.equal(body.ok, false)
  })

  it("scope tenant incohérent → refus avant toute transition", async () => {
    let scheduleCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () =>
          scopedRecord({ companyId: "co-other-tenant" }),
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 0)

    const body = await res.json()
    assert.equal(body.ok, false)
  })

  it("mailbox sans provenance explicite → refus avant toute transition", async () => {
    let scheduleCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          const record = scopedRecord()
          record.message.sourceMailboxKey = ""
          return record
        },
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 0)

    const body = await res.json()
    assert.equal(body.ok, false)
  })

  it("RUN transition appliquée mais preuve post-recovery invalide → 409 sans seconde mutation", async () => {
    let scheduleCalls = 0
    let readCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          readCalls += 1
          return scopedRecord()
        },
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 1)
    assert.equal(readCalls, 2)

    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_RECOVERY_PROOF_FAILED")
    assert.equal(body.transitioned, true)
    assert.equal(body.proof.statusDiscovered, false)
  })

  it("FAILED sans retry planifié → refus avant toute transition", async () => {
    let scheduleCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          const record = scopedRecord()
          record.attachment.downloadNextRetryAt = null
          return record
        },
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 0)
  })

  it("PLAN déjà DISCOVERED → refus avant toute transition", async () => {
    let scheduleCalls = 0

    const candidate = planCandidate()
    candidate.status = "DISCOVERED"

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [candidate],
        findAttachmentWithMessage: async () => scopedRecord(),
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 0)
  })

  it("RUN post-recovery avec un autre attachmentId → preuve refusée", async () => {
    let readCalls = 0
    let scheduleCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          readCalls += 1

          if (readCalls === 1) {
            return scopedRecord()
          }

          return scopedRecord({
            id: "att-unexpected",
            status: "DISCOVERED",
            downloadNextRetryAt: null,
          })
        },
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 1)
    assert.equal(readCalls, 2)

    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_RECOVERY_PROOF_FAILED")
    assert.equal(body.transitioned, true)
  })

  it("RUN post-recovery avec un autre draftId → preuve refusée", async () => {
    let draftCalls = 0
    let readCalls = 0
    let scheduleCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => (++draftCalls === 1 ? baseDraft() : baseDraft({ draftId: "draft-unexpected" })),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          readCalls += 1

          if (readCalls === 1) {
            return scopedRecord()
          }

          return scopedRecord({
            status: "DISCOVERED",
            downloadNextRetryAt: null,
          })
        },
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 1)
    assert.equal(readCalls, 2)
    assert.equal(draftCalls, 2)

    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_RECOVERY_PROOF_FAILED")
    assert.equal(body.transitioned, true)
  })

  it("RUN post-recovery sans provenance mailbox → preuve refusée", async () => {
    let readCalls = 0
    let scheduleCalls = 0

    const res = await handleTargetedStagingAttachmentRecovery(
      request({ confirmation: TARGETED_ATTACHMENT_RECOVERY_CONFIRMATION }),
      {
        env: PREVIEW_ENV,
        auth: adminAuth(),
        now: () => NOW,
        getRecoveryConfig: recoveryConfig,
        loadDraft: async () => baseDraft(),
        listPlanCandidates: async () => [planCandidate()],
        findAttachmentWithMessage: async () => {
          readCalls += 1

          if (readCalls === 1) {
            return scopedRecord()
          }

          const record = scopedRecord({
            status: "DISCOVERED",
            downloadNextRetryAt: null,
          })
          record.message.sourceMailboxKey = ""
          return record
        },
        scheduleRetryToDiscovered: async () => {
          scheduleCalls += 1
          return "TRANSITIONED"
        },
      }
    )

    assert.equal(res.status, 409)
    assert.equal(scheduleCalls, 1)
    assert.equal(readCalls, 2)

    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.code, "HARNESS_RECOVERY_PROOF_FAILED")
    assert.equal(body.transitioned, true)
  })
})
