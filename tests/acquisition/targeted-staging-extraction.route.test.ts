process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  TARGETED_STAGING_EXTRACTION_CHECK_CONFIRMATION,
  TARGETED_STAGING_EXTRACTION_RERUN_CHECK_CONFIRMATION,
  TARGETED_STAGING_EXTRACTION_RERUN_CONFIRMATION,
  TARGETED_STAGING_EXTRACTION_RUN_CONFIRMATION,
  handleTargetedStagingExtraction,
  type TargetedStagingExtractionDraft,
  type TargetedStagingExtractionMailboxProof,
  type TargetedStagingExtractionPlan,
} from "@/lib/acquisition/extraction/targeted-staging-extraction.handler"
import { AnthropicExtractionAdapter } from "@/lib/acquisition/extraction/anthropic-extraction.adapter"
import {
  DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
  type AnthropicPublicConfig,
} from "@/lib/acquisition/extraction/anthropic-extraction.config"
import type { ExtractionServiceDeps } from "@/lib/acquisition/extraction/extraction.service"

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

describe("targeted-staging-extraction harness — PENDING_REVIEW rerun", () => {
  const RERUN = TARGETED_STAGING_EXTRACTION_RERUN_CONFIRMATION
  const CHECK_RERUN = TARGETED_STAGING_EXTRACTION_RERUN_CHECK_CONFIRMATION

  const reviewed = (over: Partial<TargetedStagingExtractionDraft> = {}) =>
    baseDraft({ status: "PENDING_REVIEW", extractionAttemptCount: 1, version: 3, ...over })

  function anthropicConfig(): AnthropicPublicConfig {
    return {
      providerId: "anthropic",
      model: DEFAULT_ANTHROPIC_EXTRACTION_MODEL,
      maxTokens: 1024,
      timeoutMs: 5_000,
      serviceTimeoutMs: 30_000,
      maxPromptBytes: 32_768,
      maxInputBytes: 32_768,
      maxResponseBytes: 65_536,
      configured: true,
      hasApiKey: true,
    }
  }

  const extracted = {
    ok: true as const,
    outcome: "EXTRACTED" as const,
    draftId: DRAFT_ID,
    status: "PENDING_REVIEW" as const,
    contentHashAtExtraction: "hash_1",
    warningCount: 0,
  }

  function spies() {
    const calls = { rerun: 0, run: 0 }
    return {
      calls,
      runRerun: async () => {
        calls.rerun += 1
        return extracted
      },
      runExtraction: async () => {
        calls.run += 1
        throw new Error("legacy RUN must not be used")
      },
    }
  }

  it("all existing guards apply to the rerun tokens before any extraction", async () => {
    const cases: Array<[string, Record<string, unknown>, number, string]> = [
      ["surface", { env: { ...baseEnv(), VERCEL_ENV: "production" } }, 403, "HARNESS_SURFACE_FORBIDDEN"],
      ["project", { env: { ...baseEnv(), VERCEL_PROJECT_ID: "prj_other" } }, 403, "HARNESS_SURFACE_FORBIDDEN"],
      ["flag", { env: { ...baseEnv(), TARGETED_STAGING_EXTRACTION_ENABLED: "false" } }, 403, "HARNESS_DISABLED"],
      ["unauthenticated", { auth: async () => null }, 401, "UNAUTHORIZED"],
      [
        "role",
        { auth: async () => ({ user: { id: "u", role: "TEAM_LEADER", companyId: COMPANY_ID } }) },
        403,
        "FORBIDDEN",
      ],
      ["tenant", { auth: adminAuthFor("other-company") }, 403, "TENANT_MISMATCH"],
      ["no session company", { auth: adminAuthFor(null) }, 403, "TENANT_MISMATCH"],
      [
        "target unset",
        { env: { ...baseEnv(), TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: "" } },
        403,
        "HARNESS_TARGET_UNSET",
      ],
      [
        "forbidden draft",
        { env: { ...baseEnv(), TARGETED_STAGING_ATTACHMENT_NOT_READY_DRAFT_ID: "cmtvfqyhm003dz05oq9nbgg5c" } },
        403,
        "FORBIDDEN_DRAFT",
      ],
    ]
    for (const confirmation of [RERUN, CHECK_RERUN]) {
      for (const [label, over, status, code] of cases) {
        const s = spies()
        const res = await handleTargetedStagingExtraction(request({ confirmation }), {
          ...baseDeps(),
          loadDraft: async () => reviewed(),
          runRerun: s.runRerun,
          runExtraction: s.runExtraction,
          ...over,
        })
        assert.equal(res.status, status, `${confirmation} / ${label}`)
        assert.equal((await res.json()).code, code, `${confirmation} / ${label}`)
        assert.equal(s.calls.rerun + s.calls.run, 0, `${confirmation} / ${label}`)
      }
      for (const key of ["draftId", "companyId", "draft_id", "company_id"]) {
        const s = spies()
        const res = await handleTargetedStagingExtraction(request({ confirmation, [key]: "x" }), {
          ...baseDeps(),
          loadDraft: async () => reviewed(),
          runRerun: s.runRerun,
        })
        assert.equal(res.status, 400)
        assert.equal((await res.json()).code, "TARGET_OVERRIDE_FORBIDDEN")
        assert.equal(s.calls.rerun, 0)
      }
    }
  })

  it("historical CHECK / RUN still refuse PENDING_REVIEW", async () => {
    for (const confirmation of [
      TARGETED_STAGING_EXTRACTION_CHECK_CONFIRMATION,
      TARGETED_STAGING_EXTRACTION_RUN_CONFIRMATION,
    ]) {
      const s = spies()
      const res = await handleTargetedStagingExtraction(request({ confirmation }), {
        ...baseDeps(),
        loadDraft: async () => reviewed(),
        runRerun: s.runRerun,
        runExtraction: s.runExtraction,
      })
      assert.equal(res.status, 409)
      const body = await res.json()
      assert.equal(body.code, "DRAFT_STATUS_INVALID")
      assert.equal(body.message, "Draft doit être PENDING_EXTRACTION")
      assert.equal(s.calls.rerun + s.calls.run, 0)
    }
  })

  it("rerun tokens refuse every non-PENDING_REVIEW status", async () => {
    for (const status of ["PENDING_EXTRACTION", "EXTRACTING", "FAILED", "APPROVED", "REJECTED", "CONVERTED", "OBSOLETE"]) {
      for (const confirmation of [RERUN, CHECK_RERUN]) {
        const s = spies()
        const res = await handleTargetedStagingExtraction(request({ confirmation }), {
          ...baseDeps(),
          loadDraft: async () => reviewed({ status }),
          runRerun: s.runRerun,
          runExtraction: s.runExtraction,
        })
        assert.equal(res.status, 409, `${confirmation} / ${status}`)
        const body = await res.json()
        assert.equal(body.code, "DRAFT_STATUS_INVALID")
        assert.equal(body.message, "Draft doit être PENDING_REVIEW")
        assert.equal(s.calls.rerun + s.calls.run, 0)
      }
    }
  })

  it("CHECK_RERUN is read-only and reports the attempt budget without sensitive data", async () => {
    const s = spies()
    let draftReads = 0
    const res = await handleTargetedStagingExtraction(request({ confirmation: CHECK_RERUN }), {
      ...baseDeps(),
      loadDraft: async () => {
        draftReads += 1
        return reviewed({ extractionAttemptCount: 1 })
      },
      runRerun: s.runRerun,
      runExtraction: s.runExtraction,
      anthropicConfig,
      maxAttempts: () => 3,
    })
    assert.equal(res.status, 200)
    const text = await res.text()
    const body = JSON.parse(text)
    assert.equal(body.mode, "CHECK_RERUN")
    assert.equal(body.ready, true)
    assert.deepEqual(body.attemptBudget, { attemptCount: 1, maxAttempts: 3, remaining: 2, rerunAllowed: true })
    assert.equal(body.proof.draftPendingReview, true)
    assert.equal(body.proof.noCreatedWorksite, true)
    assert.equal(body.proof.detectionProofPresent, true)
    assert.equal(body.proof.anthropicConfigured, true)
    assert.equal(draftReads, 1)
    assert.equal(s.calls.rerun + s.calls.run, 0)
    for (const secret of ["nohisac3@gmail.com", "plan.pdf", "hash_1", MESSAGE_ID, ATTACHMENT_ID, DEFAULT_ANTHROPIC_EXTRACTION_MODEL, "apiKey", "test-dummy-key"]) {
      assert.ok(!text.includes(secret), `CHECK_RERUN leaks ${secret}`)
    }
  })

  it("CHECK_RERUN reports an exhausted budget / missing detection / missing provider as not ready", async () => {
    const run = async (over: Record<string, unknown>, draft: Partial<TargetedStagingExtractionDraft>) => {
      const res = await handleTargetedStagingExtraction(request({ confirmation: CHECK_RERUN }), {
        ...baseDeps(),
        loadDraft: async () => reviewed(draft),
        anthropicConfig,
        maxAttempts: () => 3,
        ...over,
      })
      return res.json()
    }
    const exhausted = await run({}, { extractionAttemptCount: 3 })
    assert.equal(exhausted.ready, false)
    assert.deepEqual(exhausted.attemptBudget, { attemptCount: 3, maxAttempts: 3, remaining: 0, rerunAllowed: false })

    const noDetection = await run({}, { detectionClassification: "AMBIGUOUS" })
    assert.equal(noDetection.ready, false)
    assert.equal(noDetection.proof.detectionProofPresent, false)

    const noProvider = await run({ anthropicConfig: () => null }, {})
    assert.equal(noProvider.ready, false)
    assert.equal(noProvider.proof.anthropicConfigured, false)
  })

  it("RERUN calls only the rerun path and proves a same-draft extraction (PENDING_REVIEW / OBSOLETE)", async () => {
    for (const finalStatus of ["PENDING_REVIEW", "OBSOLETE"]) {
      const s = spies()
      let draftReads = 0
      const before = reviewed({ extractionAttemptCount: 1, version: 3 })
      const after = reviewed({ status: finalStatus, extractionAttemptCount: 2, version: 5 })
      const res = await handleTargetedStagingExtraction(request({ confirmation: RERUN }), {
        ...baseDeps(),
        loadDraft: async () => {
          draftReads += 1
          return draftReads === 1 ? before : after
        },
        runRerun: s.runRerun,
        runExtraction: s.runExtraction,
      })
      assert.equal(res.status, 200, finalStatus)
      const body = await res.json()
      assert.equal(body.mode, "RERUN")
      assert.equal(body.outcome, "EXTRACTED")
      assert.equal(body.status, finalStatus)
      assert.deepEqual(body.proof, {
        extracted: true,
        finalStatusAllowed: true,
        attemptIncrementedExactlyOnce: true,
        versionAdvanced: true,
        noCreatedWorksite: true,
        sameTenant: true,
        sameDraft: true,
        sameMessage: true,
        startedFromPendingReview: true,
      })
      assert.equal(s.calls.rerun, 1)
      assert.equal(s.calls.run, 0)
      assert.equal(draftReads, 2)
    }
  })

  it("RERUN treats FAILED / lost race / double attempt / worksite as a failed rerun", async () => {
    const cases: Array<[string, unknown, Partial<TargetedStagingExtractionDraft>, string]> = [
      [
        "provider failure → FAILED",
        { ok: false, outcome: "FAILED", code: "PROVIDER_UNAVAILABLE", message: "x" },
        { status: "FAILED", extractionAttemptCount: 2, version: 5 },
        "extracted",
      ],
      [
        "lost claim race",
        { ok: false, outcome: "IN_PROGRESS", code: "EXTRACTION_IN_PROGRESS", message: "x" },
        { extractionAttemptCount: 1, version: 3 },
        "extracted",
      ],
      ["attempt +2", extracted, { extractionAttemptCount: 3, version: 5 }, "attemptIncrementedExactlyOnce"],
      ["version not advanced", extracted, { extractionAttemptCount: 2, version: 3 }, "versionAdvanced"],
      ["worksite created", extracted, { extractionAttemptCount: 2, version: 5, createdWorksiteId: "ws1" }, "noCreatedWorksite"],
      ["other message", extracted, { extractionAttemptCount: 2, version: 5, acquisitionMessageId: "m2" }, "sameMessage"],
      ["final FAILED status", extracted, { status: "FAILED", extractionAttemptCount: 2, version: 5 }, "finalStatusAllowed"],
    ]
    for (const [label, result, afterOver, failedKey] of cases) {
      let draftReads = 0
      const res = await handleTargetedStagingExtraction(request({ confirmation: RERUN }), {
        ...baseDeps(),
        loadDraft: async () => {
          draftReads += 1
          return draftReads === 1 ? reviewed() : reviewed(afterOver)
        },
        runRerun: async () => result as never,
      })
      assert.equal(res.status, 409, label)
      const body = await res.json()
      assert.equal(body.code, "HARNESS_EXTRACTION_PROOF_FAILED", label)
      assert.equal(body.proof[failedKey], false, label)
    }
  })

  it("default RERUN wiring injects the Anthropic adapter + local gates into the dedicated wrapper only", async () => {
    const seen: Array<{ input: unknown; deps: ExtractionServiceDeps }> = []
    let draftReads = 0
    // Clé factice : seule la construction du client SDK en dépend ; le wrapper espion n'appelle jamais extract.
    const keyBackup = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "test-dummy-key"
    const res = await handleTargetedStagingExtraction(request({ confirmation: RERUN }), {
      ...baseDeps(),
      loadDraft: async () => {
        draftReads += 1
        return draftReads === 1 ? reviewed() : reviewed({ extractionAttemptCount: 2, version: 5 })
      },
      runExtraction: async () => {
        throw new Error("legacy RUN must not be used")
      },
      anthropicConfig,
      rerunService: async (input, deps = {}) => {
        seen.push({ input, deps })
        return extracted
      },
    }).finally(() => {
      if (keyBackup === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = keyBackup
    })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0]!.input, { companyId: COMPANY_ID, draftId: DRAFT_ID })
    const deps = seen[0]!.deps
    assert.ok(deps.provider instanceof AnthropicExtractionAdapter)
    assert.equal(deps.isAcquisitionEnabled?.(), true)
    assert.equal(deps.isAcquisitionContentFetchEnabled?.(), true)
    assert.equal(deps.isAcquisitionExtractionEnabled?.(), true)
    assert.equal(deps.runAutoDecisionAfterExtraction, undefined)
    assert.equal(deps.repository, undefined)
  })

  it("default RERUN without Anthropic config never reaches the wrapper (no provider fallback)", async () => {
    let wrapperCalls = 0
    const res = await handleTargetedStagingExtraction(request({ confirmation: RERUN }), {
      ...baseDeps(),
      loadDraft: async () => reviewed(),
      anthropicConfig: () => null,
      rerunService: async () => {
        wrapperCalls += 1
        return extracted
      },
    })
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.equal(body.result.code, "PROVIDER_NOT_CONFIGURED")
    assert.equal(wrapperCalls, 0)
  })

  it("repeat after a failed / in-flight rerun is refused before any call", async () => {
    for (const status of ["FAILED", "EXTRACTING"]) {
      const s = spies()
      const res = await handleTargetedStagingExtraction(request({ confirmation: RERUN }), {
        ...baseDeps(),
        loadDraft: async () => reviewed({ status }),
        runRerun: s.runRerun,
      })
      assert.equal(res.status, 409)
      assert.equal(s.calls.rerun, 0)
    }
  })

  it("rerun confirmations are distinct from each other and from historical tokens", () => {
    const tokens = new Set([
      TARGETED_STAGING_EXTRACTION_CHECK_CONFIRMATION,
      TARGETED_STAGING_EXTRACTION_RUN_CONFIRMATION,
      CHECK_RERUN,
      RERUN,
    ])
    assert.equal(tokens.size, 4)
    assert.equal(CHECK_RERUN, "CHECK_TARGETED_STAGING_EXTRACTION_RERUN")
    assert.equal(RERUN, "RERUN_TARGETED_STAGING_EXTRACTION_PENDING_REVIEW")
  })
})
