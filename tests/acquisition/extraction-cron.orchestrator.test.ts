process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  extractionCronBackoffMinutes,
  getExtractionCronConfig,
  isAcquisitionExtractionCronEnabled,
  isExtractionRetryDue,
} from "@/lib/acquisition/extraction/extraction-cron-feature-flag"
import {
  canStartExtractionWithinBudget,
  mapExtractionOutcomeToStats,
  runAcquisitionExtractionCronOrchestrator,
} from "@/lib/acquisition/extraction/extraction-cron.orchestrator"
import { emptyExtractionCronRunStats } from "@/lib/acquisition/extraction/extraction-cron.orchestrator.types"
import type { ExtractionCronSelectionRepository } from "@/lib/acquisition/extraction/extraction-cron.selection.repository"
import type { ExtractDraftResult } from "@/lib/acquisition/extraction/extraction.types"
import { runDraftExtractionSystem } from "@/lib/acquisition/extraction/extraction.service"

const FLAG_KEYS = [
  "PLANIFICATOR_ACQUISITION_ENABLED",
  "ACQUISITION_CONTENT_FETCH_ENABLED",
  "ACQUISITION_EXTRACTION_ENABLED",
  "ACQUISITION_EXTRACTION_CRON_ENABLED",
  "ACQUISITION_EXTRACTION_MAX_PER_COMPANY",
  "ACQUISITION_EXTRACTION_MAX_PER_RUN",
  "ACQUISITION_EXTRACTION_MAX_COMPANIES_PER_RUN",
  "ACQUISITION_EXTRACTION_CRON_MAX_DURATION_MS",
  "ACQUISITION_EXTRACTION_CRON_SAFETY_MARGIN_MS",
  "ACQUISITION_EXTRACTION_TIMEOUT_MS",
  "ACQUISITION_EXTRACTION_MAX_ATTEMPTS",
  "ACQUISITION_EXTRACTION_PROVIDER",
] as const

function enableAllGates() {
  process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
  process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
  process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
  process.env.ACQUISITION_EXTRACTION_CRON_ENABLED = "true"
  process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
}

describe("extraction-cron-feature-flag", () => {
  const backup: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of FLAG_KEYS) {
      backup[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of FLAG_KEYS) {
      if (backup[k] === undefined) delete process.env[k]
      else process.env[k] = backup[k]
    }
  })

  it("cron OFF par défaut", () => {
    assert.equal(isAcquisitionExtractionCronEnabled(), false)
  })

  it("backoff min(15, 2^(n-1)) — off-by-one SPEC-R1", () => {
    assert.equal(extractionCronBackoffMinutes(0), 0)
    assert.equal(extractionCronBackoffMinutes(1), 1)
    assert.equal(extractionCronBackoffMinutes(2), 2)
    assert.equal(extractionCronBackoffMinutes(3), 4)
    assert.equal(extractionCronBackoffMinutes(4), 8)
    assert.equal(extractionCronBackoffMinutes(5), 15)
    assert.equal(extractionCronBackoffMinutes(10), 15)
  })

  it("retry dû / non dû FAILED", () => {
    const now = new Date("2026-07-22T12:00:00.000Z")
    assert.equal(
      isExtractionRetryDue({
        status: "FAILED",
        lastExtractionErrorAt: null,
        extractionAttemptCount: 1,
        now,
      }),
      false
    )
    assert.equal(
      isExtractionRetryDue({
        status: "FAILED",
        lastExtractionErrorAt: new Date("2026-07-22T11:59:30.000Z"),
        extractionAttemptCount: 1,
        now,
      }),
      false
    )
    assert.equal(
      isExtractionRetryDue({
        status: "FAILED",
        lastExtractionErrorAt: new Date("2026-07-22T11:58:00.000Z"),
        extractionAttemptCount: 1,
        now,
      }),
      true
    )
    assert.equal(
      isExtractionRetryDue({
        status: "PENDING_EXTRACTION",
        lastExtractionErrorAt: null,
        extractionAttemptCount: 0,
        now,
      }),
      true
    )
    assert.equal(
      isExtractionRetryDue({
        status: "EXTRACTING",
        lastExtractionErrorAt: null,
        extractionAttemptCount: 1,
        now,
      }),
      false
    )
  })

  it("config bornée + providerTimeout depuis 005B", () => {
    process.env.ACQUISITION_EXTRACTION_TIMEOUT_MS = "45000"
    process.env.ACQUISITION_EXTRACTION_MAX_PER_COMPANY = "999"
    const cfg = getExtractionCronConfig()
    assert.equal(cfg.providerTimeoutMs, 45_000)
    assert.equal(cfg.maxPerCompany, 200)
    assert.equal(cfg.safetyMarginMs, 5_000)
  })
})

describe("canStartExtractionWithinBudget", () => {
  it("refuse si remaining < providerTimeout + safetyMargin", () => {
    const startedAt = new Date(0)
    assert.equal(
      canStartExtractionWithinBudget({
        startedAt,
        now: new Date(200_000),
        maxDurationMs: 240_000,
        providerTimeoutMs: 30_000,
        safetyMarginMs: 5_000,
      }),
      true
    )
    assert.equal(
      canStartExtractionWithinBudget({
        startedAt,
        now: new Date(210_000),
        maxDurationMs: 240_000,
        providerTimeoutMs: 30_000,
        safetyMarginMs: 5_000,
      }),
      false
    )
  })
})

describe("mapExtractionOutcomeToStats", () => {
  it("mapping exclusif exhaustif", () => {
    const cases: Array<{ result: ExtractDraftResult; field: keyof ReturnType<typeof emptyExtractionCronRunStats> }> = [
      {
        result: {
          ok: true,
          outcome: "EXTRACTED",
          draftId: "d",
          status: "PENDING_REVIEW",
          contentHashAtExtraction: "h",
          warningCount: 0,
        },
        field: "extracted",
      },
      {
        result: {
          ok: true,
          outcome: "ALREADY_EXTRACTED",
          draftId: "d",
          status: "PENDING_REVIEW",
          contentHashAtExtraction: "h",
          warningCount: 0,
        },
        field: "alreadyExtracted",
      },
      {
        result: { ok: false, outcome: "IN_PROGRESS", code: "EXTRACTION_IN_PROGRESS", message: "x" },
        field: "inProgress",
      },
      {
        result: { ok: false, outcome: "STATE_CHANGED", code: "EXTRACTION_STATE_CHANGED", message: "x" },
        field: "stateChanged",
      },
      {
        result: { ok: false, outcome: "STALE_CONTENT", code: "STALE_CONTENT", message: "x" },
        field: "staleContent",
      },
      {
        result: { ok: false, outcome: "CONTENT_MISSING", code: "CONTENT_MISSING", message: "x" },
        field: "contentMissing",
      },
      {
        result: { ok: false, outcome: "RETRY_ALLOWED", code: "PROVIDER_TIMEOUT", message: "x" },
        field: "retryAllowed",
      },
      {
        result: { ok: false, outcome: "MAX_ATTEMPTS_REACHED", code: "EXTRACTION_MAX_ATTEMPTS", message: "x" },
        field: "maxAttemptsReached",
      },
      {
        result: { ok: false, outcome: "FAILED", code: "INTERNAL_ERROR", message: "x" },
        field: "failed",
      },
      {
        result: { ok: false, outcome: "DISABLED", code: "EXTRACTION_DISABLED", message: "x" },
        field: "failed",
      },
      {
        result: { ok: false, outcome: "NOT_FOUND", code: "DRAFT_NOT_FOUND", message: "x" },
        field: "failed",
      },
      {
        result: { ok: false, outcome: "FORBIDDEN", code: "EXTRACTION_FORBIDDEN", message: "x" },
        field: "failed",
      },
    ]

    for (const c of cases) {
      const stats = emptyExtractionCronRunStats()
      mapExtractionOutcomeToStats(stats, c.result, () => {}, { companyId: "c", draftId: "d" })
      assert.equal(stats[c.field], 1, c.field)
      const sum = Object.values(stats).reduce((a, b) => a + b, 0)
      assert.equal(sum, 1, `double count for ${c.field}`)
    }
  })
})

describe("runAcquisitionExtractionCronOrchestrator", () => {
  const backup: Record<string, string | undefined> = {}
  let listCompaniesCalls = 0
  let listCandidatesCalls = 0
  let extractCalls: string[] = []

  beforeEach(() => {
    for (const k of FLAG_KEYS) {
      backup[k] = process.env[k]
      delete process.env[k]
    }
    listCompaniesCalls = 0
    listCandidatesCalls = 0
    extractCalls = []
  })

  afterEach(() => {
    for (const k of FLAG_KEYS) {
      if (backup[k] === undefined) delete process.env[k]
      else process.env[k] = backup[k]
    }
  })

  function repo(
    overrides?: Partial<ExtractionCronSelectionRepository>
  ): ExtractionCronSelectionRepository {
    return {
      listCompanyIdsWithEligibleExtraction: async () => {
        listCompaniesCalls++
        return ["co1"]
      },
      listEligibleCandidatesForCompany: async () => {
        listCandidatesCalls++
        return [
          {
            draftId: "d1",
            companyId: "co1",
            acquisitionMessageId: "m1",
            status: "PENDING_EXTRACTION",
            createdAt: new Date(),
            extractionAttemptCount: 0,
            lastExtractionErrorAt: null,
            extractionStartedAt: null,
          },
        ]
      },
      ...overrides,
    }
  }

  it("gates OFF → SKIPPED sans listing ni extract", async () => {
    const result = await runAcquisitionExtractionCronOrchestrator({
      repository: {
        listCompanyIdsWithEligibleExtraction: async () => {
          throw new Error("should not list")
        },
        listEligibleCandidatesForCompany: async () => {
          throw new Error("should not list candidates")
        },
      },
      extractDraft: async () => {
        throw new Error("should not extract")
      },
      createRunId: () => "skip-run",
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "CRON_DISABLED")
    assert.equal(result.runId, "skip-run")
  })

  it("EXTRACTION_DISABLED gate sans mutation", async () => {
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_CRON_ENABLED = "true"
    const result = await runAcquisitionExtractionCronOrchestrator({
      repository: {
        listCompanyIdsWithEligibleExtraction: async () => {
          throw new Error("no list")
        },
        listEligibleCandidatesForCompany: async () => {
          throw new Error("no list")
        },
      },
      extractDraft: async () => {
        throw new Error("no extract")
      },
      createRunId: () => "ext-off",
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "EXTRACTION_DISABLED")
  })

  it("provider non configuré → FAILED sans extract", async () => {
    enableAllGates()
    const result = await runAcquisitionExtractionCronOrchestrator({
      repository: repo(),
      extractDraft: async () => {
        throw new Error("should not extract")
      },
      isProviderConfigured: () => false,
      createRunId: () => "no-provider",
    })
    assert.equal(result.status, "FAILED")
    assert.equal(listCompaniesCalls, 0)
    assert.equal(extractCalls.length, 0)
  })

  it("un seul appel par draft / run même si RETRY_ALLOWED", async () => {
    enableAllGates()
    const result = await runAcquisitionExtractionCronOrchestrator({
      repository: repo({
        listEligibleCandidatesForCompany: async () => {
          listCandidatesCalls++
          return [
            {
              draftId: "d1",
              companyId: "co1",
              acquisitionMessageId: "m1",
              status: "PENDING_EXTRACTION",
              createdAt: new Date(),
              extractionAttemptCount: 0,
              lastExtractionErrorAt: null,
              extractionStartedAt: null,
            },
            {
              draftId: "d1",
              companyId: "co1",
              acquisitionMessageId: "m1",
              status: "PENDING_EXTRACTION",
              createdAt: new Date(),
              extractionAttemptCount: 0,
              lastExtractionErrorAt: null,
              extractionStartedAt: null,
            },
          ]
        },
      }),
      extractDraft: async ({ draftId }) => {
        extractCalls.push(draftId)
        return {
          ok: false,
          outcome: "RETRY_ALLOWED",
          code: "PROVIDER_TIMEOUT",
          message: "retry",
          draftId,
        }
      },
      isProviderConfigured: () => true,
      createRunId: () => "once",
      config: { ...getExtractionCronConfig(), maxPerCompany: 10, maxPerRun: 10 },
    })
    assert.equal(extractCalls.length, 1)
    assert.equal(result.retryAllowed, 1)
    assert.equal(result.selected, 1)
  })

  it("throw candidat isolé → unexpectedFailed + PARTIAL + continue", async () => {
    enableAllGates()
    const result = await runAcquisitionExtractionCronOrchestrator({
      repository: repo({
        listEligibleCandidatesForCompany: async () => {
          listCandidatesCalls++
          return [
            {
              draftId: "d1",
              companyId: "co1",
              acquisitionMessageId: "m1",
              status: "PENDING_EXTRACTION",
              createdAt: new Date(),
              extractionAttemptCount: 0,
              lastExtractionErrorAt: null,
              extractionStartedAt: null,
            },
            {
              draftId: "d2",
              companyId: "co1",
              acquisitionMessageId: "m2",
              status: "PENDING_EXTRACTION",
              createdAt: new Date(),
              extractionAttemptCount: 0,
              lastExtractionErrorAt: null,
              extractionStartedAt: null,
            },
          ]
        },
      }),
      extractDraft: async ({ draftId }) => {
        extractCalls.push(draftId)
        if (draftId === "d1") throw new Error("boom")
        return {
          ok: true,
          outcome: "EXTRACTED",
          draftId,
          status: "PENDING_REVIEW",
          contentHashAtExtraction: "h",
          warningCount: 0,
        }
      },
      isProviderConfigured: () => true,
      createRunId: () => "iso",
    })
    assert.deepEqual(extractCalls, ["d1", "d2"])
    assert.equal(result.unexpectedFailed, 1)
    assert.equal(result.extracted, 1)
    assert.equal(result.status, "PARTIAL")
  })

  it("budget providerTimeout + safetyMargin stoppe avant nouveau candidat", async () => {
    enableAllGates()
    let t = 0
    const result = await runAcquisitionExtractionCronOrchestrator({
      repository: repo({
        listEligibleCandidatesForCompany: async () => [
          {
            draftId: "d1",
            companyId: "co1",
            acquisitionMessageId: "m1",
            status: "PENDING_EXTRACTION",
            createdAt: new Date(),
            extractionAttemptCount: 0,
            lastExtractionErrorAt: null,
            extractionStartedAt: null,
          },
          {
            draftId: "d2",
            companyId: "co1",
            acquisitionMessageId: "m2",
            status: "PENDING_EXTRACTION",
            createdAt: new Date(),
            extractionAttemptCount: 0,
            lastExtractionErrorAt: null,
            extractionStartedAt: null,
          },
        ],
      }),
      extractDraft: async ({ draftId }) => {
        extractCalls.push(draftId)
        t = 210_000
        return {
          ok: true,
          outcome: "EXTRACTED",
          draftId,
          status: "PENDING_REVIEW",
          contentHashAtExtraction: "h",
          warningCount: 0,
        }
      },
      isProviderConfigured: () => true,
      clock: () => new Date(t),
      createRunId: () => "budget",
      config: {
        ...getExtractionCronConfig(),
        maxDurationMs: 240_000,
        providerTimeoutMs: 30_000,
        safetyMarginMs: 5_000,
        maxPerCompany: 10,
        maxPerRun: 10,
      },
    })
    assert.deepEqual(extractCalls, ["d1"])
    assert.equal(result.budgetReached, "PROVIDER_TIMEOUT_BUDGET")
    assert.equal(result.status, "PARTIAL")
  })

  it("runDraftExtractionSystem refuse force implicite (force false)", async () => {
    enableAllGates()
    process.env.ACQUISITION_EXTRACTION_PROVIDER = "deterministic"
    const result = await runDraftExtractionSystem(
      {
        companyId: "missing-co",
        draftId: "missing-draft",
      },
      {
        repository: {
          findDraft: async () => null,
        } as unknown as import("@/lib/acquisition/extraction/extraction.repository").DraftExtractionRepository,
      }
    )
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.outcome, "NOT_FOUND")
    }
  })
})
