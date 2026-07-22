process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import {
  contentFetchBackoffMinutes,
  DEFAULT_CONTENT_CRON_MAX_ATTEMPTS,
  getContentCronConfig,
  isAcquisitionContentCronEnabled,
} from "@/lib/acquisition/content/content-cron-feature-flag"
import { classifyContentFetchError } from "@/lib/acquisition/content/message-content-fetch-error-policy"
import { runAcquisitionContentCronOrchestrator } from "@/lib/acquisition/content/message-content-cron.orchestrator"
import type {
  ContentCronFetchPort,
  ContentFetchOrchestratorRepository,
} from "@/lib/acquisition/content/message-content-cron.orchestrator.types"
import type {
  FetchMessageContentResult,
  MessageContentErrorCode,
  MessageContentRecord,
} from "@/lib/acquisition/content/message-content.types"

const FLAG_KEYS = [
  "PLANIFICATOR_ACQUISITION_ENABLED",
  "ACQUISITION_CONTENT_FETCH_ENABLED",
  "ACQUISITION_CONTENT_CRON_ENABLED",
  "ACQUISITION_CONTENT_MAX_PER_COMPANY",
  "ACQUISITION_CONTENT_MAX_PER_RUN",
  "ACQUISITION_CONTENT_MAX_COMPANIES_PER_RUN",
  "ACQUISITION_CONTENT_CRON_MAX_DURATION_MS",
  "ACQUISITION_CONTENT_CRON_MAX_ATTEMPTS",
] as const

function fakeContent(partial?: Partial<MessageContentRecord>): MessageContentRecord {
  const now = new Date()
  return {
    id: "c1",
    companyId: "co1",
    acquisitionMessageId: "m1",
    normalizedText: "hello",
    contentHash: "abc12345deadbeef",
    sourceMimeType: "text/plain",
    sourceCharset: "utf-8",
    hadHtml: false,
    byteLengthOriginal: 5,
    fetchedAt: now,
    sanitizedAt: now,
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}

function ok(
  outcome: "FETCHED" | "ALREADY_FETCHED" | "UPDATED"
): FetchMessageContentResult {
  return {
    ok: true,
    outcome,
    content: fakeContent(),
    idempotent: outcome === "ALREADY_FETCHED",
  }
}

function fail(code: MessageContentErrorCode): FetchMessageContentResult {
  return { ok: false, outcome: "FAILED", code, message: code }
}

describe("content-cron-feature-flag", () => {
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
    assert.equal(isAcquisitionContentCronEnabled(), false)
  })

  it("backoff min(15, 2^n)", () => {
    assert.equal(contentFetchBackoffMinutes(1), 2)
    assert.equal(contentFetchBackoffMinutes(3), 8)
    assert.equal(contentFetchBackoffMinutes(4), 15)
    assert.equal(contentFetchBackoffMinutes(10), 15)
  })

  it("config bornée", () => {
    process.env.ACQUISITION_CONTENT_CRON_MAX_ATTEMPTS = "99"
    assert.equal(getContentCronConfig().maxAttempts, 20)
    assert.equal(DEFAULT_CONTENT_CRON_MAX_ATTEMPTS, 5)
  })
})

describe("classifyContentFetchError", () => {
  it("classe les codes SPEC", () => {
    assert.equal(classifyContentFetchError("GMAIL_RATE_LIMITED"), "RETRYABLE")
    assert.equal(classifyContentFetchError("CONTENT_EMPTY"), "PERMANENT")
    assert.equal(classifyContentFetchError("GMAIL_NOT_CONNECTED"), "CONFIG_TENANT")
    assert.equal(classifyContentFetchError("CONTENT_FORBIDDEN"), "UI_ONLY")
  })
})

describe("runAcquisitionContentCronOrchestrator", () => {
  const backup: Record<string, string | undefined> = {}
  let listCompaniesCalls = 0
  let listCandidatesCalls = 0
  let fetchCalls = 0
  let markRetryCalls = 0
  let markPermanentCalls = 0

  beforeEach(() => {
    for (const k of FLAG_KEYS) {
      backup[k] = process.env[k]
      delete process.env[k]
    }
    listCompaniesCalls = 0
    listCandidatesCalls = 0
    fetchCalls = 0
    markRetryCalls = 0
    markPermanentCalls = 0
  })

  afterEach(() => {
    for (const k of FLAG_KEYS) {
      if (backup[k] === undefined) delete process.env[k]
      else process.env[k] = backup[k]
    }
  })

  function repo(overrides?: Partial<ContentFetchOrchestratorRepository>): ContentFetchOrchestratorRepository {
    return {
      listCompanyIdsWithEligibleContentFetch: async () => {
        listCompaniesCalls++
        return ["co1"]
      },
      listEligibleCandidatesForCompany: async () => {
        listCandidatesCalls++
        return [
          {
            draftId: "d1",
            acquisitionMessageId: "m1",
            companyId: "co1",
            draftCreatedAt: new Date("2026-01-01T00:00:00Z"),
          },
        ]
      },
      hasContent: async () => false,
      markRetryableFailure: async () => {
        markRetryCalls++
        return { terminal: false, attemptCount: 1 }
      },
      markPermanentFailure: async () => {
        markPermanentCalls++
        return { terminal: true, attemptCount: 1 }
      },
      ...overrides,
    }
  }

  it("flags OFF → SKIPPED zéro mutation", async () => {
    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo({
        listCompanyIdsWithEligibleContentFetch: async () => {
          throw new Error("should not list")
        },
      }),
      fetchContent: async () => {
        throw new Error("should not fetch")
      },
      createRunId: () => "run-skip",
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "CRON_DISABLED")
    assert.equal(listCompaniesCalls, 0)
    assert.equal(fetchCalls, 0)
  })

  it("cron ON + master OFF → MASTER_DISABLED", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo({
        listCompanyIdsWithEligibleContentFetch: async () => {
          throw new Error("no list")
        },
      }),
      fetchContent: async () => {
        throw new Error("no fetch")
      },
      createRunId: () => "run-master",
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "MASTER_DISABLED")
  })

  it("cron ON + content OFF → CONTENT_FETCH_DISABLED", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo({
        listCompanyIdsWithEligibleContentFetch: async () => {
          throw new Error("no list")
        },
      }),
      fetchContent: async () => {
        throw new Error("no fetch")
      },
      createRunId: () => "run-cap",
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "CONTENT_FETCH_DISABLED")
  })

  it("fetch SUCCESS + alreadyPresent concurrence", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"

    const fetch: ContentCronFetchPort = async () => {
      fetchCalls++
      return fetchCalls === 1 ? ok("FETCHED") : ok("ALREADY_FETCHED")
    }

    const first = await runAcquisitionContentCronOrchestrator({
      repository: repo(),
      fetchContent: fetch,
      createRunId: () => "run-ok",
    })
    assert.equal(first.status, "SUCCESS")
    assert.equal(first.fetched, 1)

    listCandidatesCalls = 0
    const second = await runAcquisitionContentCronOrchestrator({
      repository: repo(),
      fetchContent: fetch,
      createRunId: () => "run-dup",
    })
    assert.equal(second.alreadyPresent, 1)
    assert.equal(second.duplicateFetchSuspected, 1)
    assert.equal(markPermanentCalls, 0)
  })

  it("erreur permanente → markPermanentFailure", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"

    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo(),
      fetchContent: async () => {
        fetchCalls++
        return fail("CONTENT_EMPTY")
      },
      createRunId: () => "run-perm",
    })
    assert.equal(result.permanentFailed, 1)
    assert.equal(markPermanentCalls, 1)
    assert.equal(result.status, "PARTIAL")
  })

  it("échec après content concurrent → alreadyPresent, pas de terminal", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"

    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo({
        markPermanentFailure: async () => {
          markPermanentCalls++
          return { terminal: false, attemptCount: 0, skippedDueToContent: true }
        },
      }),
      fetchContent: async () => fail("CONTENT_EMPTY"),
      createRunId: () => "run-race-ok",
    })
    assert.equal(result.alreadyPresent, 1)
    assert.equal(result.duplicateFetchSuspected, 1)
    assert.equal(result.permanentFailed, 0)
    assert.equal(markPermanentCalls, 1)
  })

  it("CONFIG_TENANT ne terminalise pas", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    const logs: string[] = []

    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo({
        listEligibleCandidatesForCompany: async () => [
          {
            draftId: "d1",
            acquisitionMessageId: "m1",
            companyId: "co1",
            draftCreatedAt: new Date(),
          },
          {
            draftId: "d2",
            acquisitionMessageId: "m2",
            companyId: "co1",
            draftCreatedAt: new Date(),
          },
        ],
      }),
      fetchContent: async () => fail("GMAIL_NOT_CONNECTED"),
      logger: (event) => {
        logs.push(event)
      },
      createRunId: () => "run-cfg",
    })
    assert.equal(result.companiesSkipped, 1)
    assert.equal(markPermanentCalls, 0)
    assert.equal(result.skipped, 1)
    assert.ok(logs.includes("CONTENT_FETCH_TENANT_CONFIGURATION_FAILURE"))
    assert.ok(!logs.includes("CONTENT_FETCH_RETRYABLE_FAILURE"))
  })

  it("erreur retryable → markRetryableFailure", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"

    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo(),
      fetchContent: async () => fail("GMAIL_RATE_LIMITED"),
      createRunId: () => "run-retry",
    })
    assert.equal(result.retryableFailed, 1)
    assert.equal(markRetryCalls, 1)
  })

  it("échec markFailure → run continue (pas d’abort)", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    const logs: string[] = []

    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo({
        listEligibleCandidatesForCompany: async () => [
          {
            draftId: "d1",
            acquisitionMessageId: "m1",
            companyId: "co1",
            draftCreatedAt: new Date(),
          },
          {
            draftId: "d2",
            acquisitionMessageId: "m2",
            companyId: "co1",
            draftCreatedAt: new Date(),
          },
        ],
        markRetryableFailure: async () => {
          throw new Error("CONTENT_FETCH_STATE_INCREMENT_FAILED")
        },
      }),
      fetchContent: async ({ acquisitionMessageId }) => {
        fetchCalls++
        if (acquisitionMessageId === "m1") return fail("GMAIL_RATE_LIMITED")
        return ok("FETCHED")
      },
      logger: (event) => {
        logs.push(event)
      },
      createRunId: () => "run-mark-fail",
    })
    assert.equal(result.fetched, 1)
    assert.equal(result.skipped, 1)
    assert.equal(result.retryableFailed, 0)
    assert.equal(result.status, "PARTIAL")
    assert.ok(logs.includes("CONTENT_FETCH_STATE_MARK_FAILED"))
    assert.ok(logs.includes("CONTENT_RUN_FINISHED"))
  })

  it("throw fetchContent → isole le candidat, traite le suivant, run PARTIAL", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    const logs: string[] = []
    const payloads: Array<Record<string, unknown> | undefined> = []

    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo({
        listEligibleCandidatesForCompany: async () => [
          {
            draftId: "d1",
            acquisitionMessageId: "m1",
            companyId: "co1",
            draftCreatedAt: new Date(),
          },
          {
            draftId: "d2",
            acquisitionMessageId: "m2",
            companyId: "co1",
            draftCreatedAt: new Date(),
          },
        ],
      }),
      fetchContent: async ({ acquisitionMessageId }) => {
        fetchCalls++
        if (acquisitionMessageId === "m1") {
          throw new Error("provider boom stack TOKEN=secret subject=private")
        }
        return ok("FETCHED")
      },
      logger: (event, payload) => {
        logs.push(event)
        payloads.push(payload)
      },
      createRunId: () => "run-throw",
    })

    assert.equal(fetchCalls, 2)
    assert.equal(result.fetched, 1)
    assert.equal(result.retryableFailed, 1)
    assert.equal(markRetryCalls, 1)
    assert.equal(result.status, "PARTIAL")
    assert.ok(logs.includes("CONTENT_FETCH_UNEXPECTED_FAILURE"))
    assert.ok(logs.includes("CONTENT_FETCH_RETRYABLE_FAILURE"))
    assert.ok(logs.includes("CONTENT_RUN_FINISHED"))

    const unexpected = payloads.find(
      (_, i) => logs[i] === "CONTENT_FETCH_UNEXPECTED_FAILURE"
    )
    assert.ok(unexpected)
    assert.equal(unexpected!.errorCode, "CONTENT_FETCH_FAILED")
    assert.equal(unexpected!.acquisitionMessageId, "m1")
    const serialized = JSON.stringify({ logs, payloads, result })
    assert.ok(!serialized.includes("provider boom"))
    assert.ok(!serialized.includes("TOKEN=secret"))
    assert.ok(!serialized.includes("subject=private"))
  })

  it("throw fetchContent + markRetryableFailure échoue → MARK_FAILED, run continue", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    const logs: string[] = []

    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo({
        listEligibleCandidatesForCompany: async () => [
          {
            draftId: "d1",
            acquisitionMessageId: "m1",
            companyId: "co1",
            draftCreatedAt: new Date(),
          },
          {
            draftId: "d2",
            acquisitionMessageId: "m2",
            companyId: "co1",
            draftCreatedAt: new Date(),
          },
        ],
        markRetryableFailure: async () => {
          throw new Error("CONTENT_FETCH_STATE_INCREMENT_FAILED")
        },
      }),
      fetchContent: async ({ acquisitionMessageId }) => {
        fetchCalls++
        if (acquisitionMessageId === "m1") {
          throw new Error("unexpected provider failure")
        }
        return ok("FETCHED")
      },
      logger: (event) => {
        logs.push(event)
      },
      createRunId: () => "run-throw-mark",
    })

    assert.equal(result.fetched, 1)
    assert.equal(result.skipped, 1)
    assert.equal(result.retryableFailed, 0)
    assert.equal(result.status, "PARTIAL")
    assert.ok(logs.includes("CONTENT_FETCH_UNEXPECTED_FAILURE"))
    assert.ok(logs.includes("CONTENT_FETCH_STATE_MARK_FAILED"))
    assert.ok(logs.includes("CONTENT_RUN_FINISHED"))
  })

  it("tenant A throw → tenant B traité normalement", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    const logs: string[] = []
    const fetchedIds: string[] = []

    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo({
        listCompanyIdsWithEligibleContentFetch: async () => ["coA", "coB"],
        listEligibleCandidatesForCompany: async ({ companyId }) => [
          {
            draftId: `d-${companyId}`,
            acquisitionMessageId: `m-${companyId}`,
            companyId,
            draftCreatedAt: new Date(),
          },
        ],
      }),
      fetchContent: async ({ companyId, acquisitionMessageId }) => {
        fetchCalls++
        if (companyId === "coA") {
          throw new Error("tenant A provider crash")
        }
        fetchedIds.push(acquisitionMessageId)
        return ok("FETCHED")
      },
      logger: (event) => {
        logs.push(event)
      },
      createRunId: () => "run-throw-tenant",
    })

    assert.equal(fetchCalls, 2)
    assert.deepEqual(fetchedIds, ["m-coB"])
    assert.equal(result.fetched, 1)
    assert.equal(result.retryableFailed, 1)
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.companiesPartial, 1)
    assert.equal(result.companiesSucceeded, 1)
    assert.ok(logs.includes("CONTENT_FETCH_UNEXPECTED_FAILURE"))
    assert.ok(!JSON.stringify(logs).includes("tenant A provider crash"))
  })

  it("budget maxPerRun → PARTIAL", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"

    const result = await runAcquisitionContentCronOrchestrator({
      repository: repo({
        listCompanyIdsWithEligibleContentFetch: async () => ["co1", "co2"],
        listEligibleCandidatesForCompany: async ({ companyId }) => [
          {
            draftId: `d-${companyId}`,
            acquisitionMessageId: `m-${companyId}`,
            companyId,
            draftCreatedAt: new Date(),
          },
        ],
      }),
      fetchContent: async () => ok("FETCHED"),
      createRunId: () => "run-budget",
      config: {
        maxPerCompany: 20,
        maxPerRun: 1,
        maxCompaniesPerRun: 20,
        maxDurationMs: 240_000,
        maxAttempts: 5,
      },
    })
    assert.equal(result.budgetReached, "MAX_MESSAGES_PER_RUN")
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.fetched, 1)
  })
})
