process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { handleAcquisitionAttachmentDownloadCron } from "@/lib/acquisition/attachments/attachment-download-cron.handler"
import { runAcquisitionAttachmentDownloadOrchestrator } from "@/lib/acquisition/attachments/attachment-download-orchestrator"
import {
  DEFAULT_ATTACHMENT_MAX_COMPANIES_PER_RUN,
  DEFAULT_ATTACHMENT_MAX_PER_COMPANY,
  DEFAULT_ATTACHMENT_MAX_PER_RUN,
  DEFAULT_ATTACHMENT_CRON_MAX_DURATION_MS,
} from "@/lib/acquisition/attachments/attachment-download-cron-feature-flag"

const CRON_SECRET = "test-cron-secret-download"

function request(authHeader?: string): Request {
  return new Request("http://localhost/api/cron/acquisition-attachment-download", {
    method: "GET",
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe("handleAcquisitionAttachmentDownloadCron", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    delete process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED
  })

  it("CRON_SECRET absent → HTTP 401", async () => {
    const res = await handleAcquisitionAttachmentDownloadCron(request())
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.deepEqual(body, { error: "Unauthorized" })
  })

  it("Bearer incorrect → HTTP 401", async () => {
    const res = await handleAcquisitionAttachmentDownloadCron(request("Bearer wrong-secret"))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, "Unauthorized")
    assert.ok(!JSON.stringify(body).includes(CRON_SECRET))
  })

  it("flag off → 200 SKIPPED", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "false"
    const res = await handleAcquisitionAttachmentDownloadCron(request(`Bearer ${CRON_SECRET}`), {
      runOrchestrator: () =>
        runAcquisitionAttachmentDownloadOrchestrator({
          repository: {
            listCompanyIdsWithDiscoveredAttachments: async () => {
              throw new Error("should not list")
            },
            listDiscoveredAttachmentsForCompany: async () => {
              throw new Error("should not list attachments")
            },
          },
          downloadAttachment: async () => ({ outcome: "STORED" }),
          createRunId: () => "route-skip",
        }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, "SKIPPED")
    assert.equal(body.skipReason, "CRON_DISABLED")
    assert.equal(body.runId, "route-skip")
  })

  it("cron ON + master OFF → 200 MASTER_DISABLED", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const res = await handleAcquisitionAttachmentDownloadCron(request(`Bearer ${CRON_SECRET}`), {
      runOrchestrator: () =>
        runAcquisitionAttachmentDownloadOrchestrator({
          repository: {
            listCompanyIdsWithDiscoveredAttachments: async () => {
              throw new Error("should not list")
            },
            listDiscoveredAttachmentsForCompany: async () => [],
          },
          downloadAttachment: async () => ({ outcome: "STORED" }),
          createRunId: () => "route-master-off",
        }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, "SKIPPED")
    assert.equal(body.skipReason, "MASTER_DISABLED")
  })

  it("cron ON + capability OFF → DOWNLOAD_CAPABILITY_DISABLED", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "false"
    const res = await handleAcquisitionAttachmentDownloadCron(request(`Bearer ${CRON_SECRET}`), {
      runOrchestrator: () =>
        runAcquisitionAttachmentDownloadOrchestrator({
          repository: {
            listCompanyIdsWithDiscoveredAttachments: async () => {
              throw new Error("should not list")
            },
            listDiscoveredAttachmentsForCompany: async () => [],
          },
          downloadAttachment: async () => ({ outcome: "STORED" }),
          createRunId: () => "route-cap-off",
        }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, "SKIPPED")
    assert.equal(body.skipReason, "DOWNLOAD_CAPABILITY_DISABLED")
  })

  it("flags valides → orchestrateur appelé une fois", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    let calls = 0
    const res = await handleAcquisitionAttachmentDownloadCron(request(`Bearer ${CRON_SECRET}`), {
      runOrchestrator: async () => {
        calls += 1
        return {
          status: "SUCCESS",
          runId: "route-once",
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 1,
          companiesTotal: 0,
          companiesSucceeded: 0,
          companiesPartial: 0,
          companiesFailed: 0,
          companiesSkipped: 0,
          globalStats: {
            attempted: 0,
            stored: 0,
            alreadyStored: 0,
            alreadyInProgress: 0,
            rejected: 0,
            failed: 0,
            skipped: 0,
          },
          companies: [],
          config: {
            maxPerCompany: DEFAULT_ATTACHMENT_MAX_PER_COMPANY,
            maxPerRun: DEFAULT_ATTACHMENT_MAX_PER_RUN,
            maxCompaniesPerRun: DEFAULT_ATTACHMENT_MAX_COMPANIES_PER_RUN,
            maxDurationMs: DEFAULT_ATTACHMENT_CRON_MAX_DURATION_MS,
          },
        }
      },
    })
    assert.equal(res.status, 200)
    assert.equal(calls, 1)
    assert.equal((await res.json()).runId, "route-once")
  })

  it("succès → 200 SUCCESS", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    const res = await handleAcquisitionAttachmentDownloadCron(request(`Bearer ${CRON_SECRET}`), {
      runOrchestrator: async () => ({
        status: "SUCCESS",
        runId: "route-ok",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 1,
        companiesTotal: 1,
        companiesSucceeded: 1,
        companiesPartial: 0,
        companiesFailed: 0,
        companiesSkipped: 0,
        globalStats: {
          attempted: 1,
          stored: 1,
          alreadyStored: 0,
          alreadyInProgress: 0,
          rejected: 0,
          failed: 0,
          skipped: 0,
        },
        companies: [],
        config: {
          maxPerCompany: DEFAULT_ATTACHMENT_MAX_PER_COMPANY,
          maxPerRun: DEFAULT_ATTACHMENT_MAX_PER_RUN,
          maxCompaniesPerRun: DEFAULT_ATTACHMENT_MAX_COMPANIES_PER_RUN,
          maxDurationMs: DEFAULT_ATTACHMENT_CRON_MAX_DURATION_MS,
        },
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, "SUCCESS")
    assert.equal(body.runId, "route-ok")
  })

  it("partiel → 200 PARTIAL", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    const res = await handleAcquisitionAttachmentDownloadCron(request(`Bearer ${CRON_SECRET}`), {
      runOrchestrator: async () => ({
        status: "PARTIAL",
        runId: "route-partial",
        budgetReached: "MAX_ATTACHMENTS_PER_RUN",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 2,
        companiesTotal: 1,
        companiesSucceeded: 0,
        companiesPartial: 1,
        companiesFailed: 0,
        companiesSkipped: 0,
        globalStats: {
          attempted: 2,
          stored: 2,
          alreadyStored: 0,
          alreadyInProgress: 0,
          rejected: 0,
          failed: 0,
          skipped: 0,
        },
        companies: [],
        config: {
          maxPerCompany: 20,
          maxPerRun: 2,
          maxCompaniesPerRun: 20,
          maxDurationMs: 240000,
        },
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, "PARTIAL")
  })

  it("erreur listing → 200 FAILED structuré", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const res = await handleAcquisitionAttachmentDownloadCron(request(`Bearer ${CRON_SECRET}`), {
      runOrchestrator: () =>
        runAcquisitionAttachmentDownloadOrchestrator({
          repository: {
            listCompanyIdsWithDiscoveredAttachments: async () => {
              throw new Error("postgresql://user:password@host/db")
            },
            listDiscoveredAttachmentsForCompany: async () => [],
          },
          downloadAttachment: async () => ({ outcome: "STORED" }),
          createRunId: () => "route-fail",
        }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.status, "FAILED")
    assert.equal(body.errorCode, "ATTACHMENT_CANDIDATE_LISTING_FAILED")
    const serialized = JSON.stringify(body)
    assert.ok(!serialized.includes("postgresql"))
    assert.ok(!serialized.includes("password"))
    assert.ok(!serialized.includes(CRON_SECRET))
  })
})
