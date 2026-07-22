process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { handleAcquisitionContentFetchCron } from "@/lib/acquisition/content/message-content-cron.handler"
import { runAcquisitionContentCronOrchestrator } from "@/lib/acquisition/content/message-content-cron.orchestrator"
import { getContentCronConfig } from "@/lib/acquisition/content/content-cron-feature-flag"

const CRON_SECRET = "test-cron-secret-content"

function request(authHeader?: string): Request {
  return new Request("http://localhost/api/cron/acquisition-content-fetch", {
    method: "GET",
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe("handleAcquisitionContentFetchCron", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    delete process.env.ACQUISITION_CONTENT_CRON_ENABLED
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    delete process.env.ACQUISITION_CONTENT_FETCH_ENABLED
  })

  it("CRON_SECRET absent → 401", async () => {
    const res = await handleAcquisitionContentFetchCron(request())
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: "Unauthorized" })
  })

  it("Bearer incorrect → 401", async () => {
    const res = await handleAcquisitionContentFetchCron(request("Bearer wrong"))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, "Unauthorized")
    assert.ok(!JSON.stringify(body).includes(CRON_SECRET))
  })

  it("cron OFF → 200 SKIPPED sans listing", async () => {
    const res = await handleAcquisitionContentFetchCron(request(`Bearer ${CRON_SECRET}`), {
      runOrchestrator: () =>
        runAcquisitionContentCronOrchestrator({
          repository: {
            listCompanyIdsWithEligibleContentFetch: async () => {
              throw new Error("should not list")
            },
            listEligibleCandidatesForCompany: async () => {
              throw new Error("should not list candidates")
            },
            hasContent: async () => {
              throw new Error("should not hasContent")
            },
            markRetryableFailure: async () => {
              throw new Error("should not mark")
            },
            markPermanentFailure: async () => {
              throw new Error("should not mark")
            },
          },
          fetchContent: async () => {
            throw new Error("should not fetch")
          },
          createRunId: () => "route-skip",
          config: getContentCronConfig(),
        }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, "SKIPPED")
    assert.equal(body.skipReason, "CRON_DISABLED")
    assert.equal(body.runId, "route-skip")
  })

  it("flags valides → orchestrateur appelé une fois", async () => {
    process.env.ACQUISITION_CONTENT_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    let calls = 0
    const res = await handleAcquisitionContentFetchCron(request(`Bearer ${CRON_SECRET}`), {
      runOrchestrator: async () => {
        calls++
        return {
          status: "SUCCESS",
          runId: "once",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 1,
          companiesSelected: 0,
          companiesProcessed: 0,
          companiesSucceeded: 0,
          companiesPartial: 0,
          companiesFailed: 0,
          companiesSkipped: 0,
          selected: 0,
          fetched: 0,
          alreadyPresent: 0,
          updated: 0,
          retryableFailed: 0,
          permanentFailed: 0,
          skipped: 0,
          duplicateFetchSuspected: 0,
          companies: [],
          config: getContentCronConfig(),
        }
      },
    })
    assert.equal(res.status, 200)
    assert.equal(calls, 1)
    const body = await res.json()
    assert.equal(body.runId, "once")
    assert.ok(!JSON.stringify(body).includes("normalizedText"))
  })
})

describe("acquisition-content-fetch route maxDuration", () => {
  it("exporte maxDuration = 300", async () => {
    const mod = await import("@/app/api/cron/acquisition-content-fetch/route")
    assert.equal(mod.maxDuration, 300)
  })
})
