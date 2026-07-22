process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { handleAcquisitionExtractionCron } from "@/lib/acquisition/extraction/extraction-cron.handler"
import { runAcquisitionExtractionCronOrchestrator } from "@/lib/acquisition/extraction/extraction-cron.orchestrator"
import { getExtractionCronConfig } from "@/lib/acquisition/extraction/extraction-cron-feature-flag"

const CRON_SECRET = "test-cron-secret-extraction"

function request(authHeader?: string): Request {
  return new Request("http://localhost/api/cron/acquisition-extraction", {
    method: "GET",
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe("handleAcquisitionExtractionCron", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    delete process.env.ACQUISITION_EXTRACTION_CRON_ENABLED
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    delete process.env.ACQUISITION_CONTENT_FETCH_ENABLED
    delete process.env.ACQUISITION_EXTRACTION_ENABLED
  })

  it("CRON_SECRET absent → 401 avant I/O", async () => {
    const res = await handleAcquisitionExtractionCron(request())
    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: "Unauthorized" })
  })

  it("Bearer incorrect → 401", async () => {
    const res = await handleAcquisitionExtractionCron(request("Bearer wrong"))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, "Unauthorized")
    assert.ok(!JSON.stringify(body).includes(CRON_SECRET))
  })

  it("cron OFF → 200 SKIPPED sans listing", async () => {
    const res = await handleAcquisitionExtractionCron(request(`Bearer ${CRON_SECRET}`), {
      runOrchestrator: () =>
        runAcquisitionExtractionCronOrchestrator({
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
          createRunId: () => "route-skip",
          config: getExtractionCronConfig(),
        }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, "SKIPPED")
    assert.equal(body.skipReason, "CRON_DISABLED")
    assert.equal(body.runId, "route-skip")
  })

  it("chaque gate OFF → SKIPPED dédié", async () => {
    const cases: Array<{ env: Record<string, string>; skip: string }> = [
      { env: {}, skip: "CRON_DISABLED" },
      {
        env: {
          ACQUISITION_EXTRACTION_CRON_ENABLED: "true",
          ACQUISITION_CONTENT_FETCH_ENABLED: "true",
          ACQUISITION_EXTRACTION_ENABLED: "true",
        },
        skip: "MASTER_DISABLED",
      },
      {
        env: {
          PLANIFICATOR_ACQUISITION_ENABLED: "true",
          ACQUISITION_EXTRACTION_CRON_ENABLED: "true",
          ACQUISITION_EXTRACTION_ENABLED: "true",
        },
        skip: "CONTENT_FETCH_DISABLED",
      },
      {
        env: {
          PLANIFICATOR_ACQUISITION_ENABLED: "true",
          ACQUISITION_CONTENT_FETCH_ENABLED: "true",
          ACQUISITION_EXTRACTION_CRON_ENABLED: "true",
        },
        skip: "EXTRACTION_DISABLED",
      },
    ]

    for (const c of cases) {
      delete process.env.ACQUISITION_EXTRACTION_CRON_ENABLED
      delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
      delete process.env.ACQUISITION_CONTENT_FETCH_ENABLED
      delete process.env.ACQUISITION_EXTRACTION_ENABLED
      for (const [k, v] of Object.entries(c.env)) process.env[k] = v

      const res = await handleAcquisitionExtractionCron(request(`Bearer ${CRON_SECRET}`), {
        runOrchestrator: () =>
          runAcquisitionExtractionCronOrchestrator({
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
            createRunId: () => `gate-${c.skip}`,
          }),
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.status, "SKIPPED")
      assert.equal(body.skipReason, c.skip)
    }
  })

  it("flags valides → orchestrateur appelé une fois", async () => {
    process.env.ACQUISITION_EXTRACTION_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_CONTENT_FETCH_ENABLED = "true"
    process.env.ACQUISITION_EXTRACTION_ENABLED = "true"
    let calls = 0
    const res = await handleAcquisitionExtractionCron(request(`Bearer ${CRON_SECRET}`), {
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
          extracted: 0,
          alreadyExtracted: 0,
          inProgress: 0,
          stateChanged: 0,
          staleContent: 0,
          contentMissing: 0,
          retryAllowed: 0,
          maxAttemptsReached: 0,
          failed: 0,
          unexpectedFailed: 0,
          skipped: 0,
          companies: [],
          config: getExtractionCronConfig(),
        }
      },
    })
    assert.equal(res.status, 200)
    assert.equal(calls, 1)
    const body = await res.json()
    assert.equal(body.runId, "once")
    assert.ok(!JSON.stringify(body).includes("normalizedText"))
    assert.ok(!JSON.stringify(body).includes("stack"))
  })
})

describe("acquisition-extraction route maxDuration", () => {
  it("exporte maxDuration = 300", async () => {
    const mod = await import("@/app/api/cron/acquisition-extraction/route")
    assert.equal(mod.maxDuration, 300)
  })
})
