process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_ATTACHMENT_CRON_MAX_DURATION_MS,
  DEFAULT_ATTACHMENT_MAX_COMPANIES_PER_RUN,
  DEFAULT_ATTACHMENT_MAX_PER_COMPANY,
  DEFAULT_ATTACHMENT_MAX_PER_RUN,
  getAttachmentDownloadCronConfig,
} from "@/lib/acquisition/attachments/attachment-download-cron-feature-flag"
import { runAcquisitionAttachmentDownloadOrchestrator } from "@/lib/acquisition/attachments/attachment-download-orchestrator"
import type {
  AttachmentDownloadOrchestratorDownloadPort,
  AttachmentDownloadOrchestratorRepository,
  DiscoveredAttachmentCandidate,
} from "@/lib/acquisition/attachments/attachment-download-orchestrator.types"
import type { AttachmentDownloadOutcome } from "@/lib/acquisition/attachments/attachment.types"

function candidate(
  companyId: string,
  id: string,
  createdAt = new Date("2026-01-01T00:00:00.000Z")
): DiscoveredAttachmentCandidate {
  return { id, companyId, createdAt }
}

function mockRepo(opts: {
  companyIds?: string[] | (() => Promise<string[]>)
  byCompany?: Record<string, DiscoveredAttachmentCandidate[]>
  listCompanyThrow?: Error
  listAttachmentsThrow?: Error
}): AttachmentDownloadOrchestratorRepository {
  return {
    listCompanyIdsWithDiscoveredAttachments: async ({ limit }) => {
      if (opts.listCompanyThrow) throw opts.listCompanyThrow
      const ids =
        typeof opts.companyIds === "function" ? await opts.companyIds() : (opts.companyIds ?? [])
      return ids.slice(0, limit)
    },
    listDiscoveredAttachmentsForCompany: async ({ companyId, limit }) => {
      if (opts.listAttachmentsThrow) throw opts.listAttachmentsThrow
      return (opts.byCompany?.[companyId] ?? []).slice(0, limit)
    },
  }
}

function mockDownload(
  impl: (input: { companyId: string; attachmentId: string }) => Promise<{ outcome: AttachmentDownloadOutcome }>
): {
  calls: Array<{ companyId: string; attachmentId: string }>
  fn: AttachmentDownloadOrchestratorDownloadPort
} {
  const calls: Array<{ companyId: string; attachmentId: string }> = []
  return {
    calls,
    fn: async (input) => {
      calls.push({ ...input })
      return impl(input)
    },
  }
}

describe("attachment-download-cron config", () => {
  beforeEach(() => {
    delete process.env.ACQUISITION_ATTACHMENT_MAX_PER_COMPANY
    delete process.env.ACQUISITION_ATTACHMENT_MAX_PER_RUN
    delete process.env.ACQUISITION_ATTACHMENT_MAX_COMPANIES_PER_RUN
    delete process.env.ACQUISITION_ATTACHMENT_CRON_MAX_DURATION_MS
  })

  it("défauts sûrs", () => {
    const c = getAttachmentDownloadCronConfig()
    assert.equal(c.maxPerCompany, DEFAULT_ATTACHMENT_MAX_PER_COMPANY)
    assert.equal(c.maxPerRun, DEFAULT_ATTACHMENT_MAX_PER_RUN)
    assert.equal(c.maxCompaniesPerRun, DEFAULT_ATTACHMENT_MAX_COMPANIES_PER_RUN)
    assert.equal(c.maxDurationMs, DEFAULT_ATTACHMENT_CRON_MAX_DURATION_MS)
  })

  it("valeurs invalides → défauts", () => {
    process.env.ACQUISITION_ATTACHMENT_MAX_PER_COMPANY = "-1"
    process.env.ACQUISITION_ATTACHMENT_MAX_PER_RUN = "NaN"
    process.env.ACQUISITION_ATTACHMENT_MAX_COMPANIES_PER_RUN = "0"
    process.env.ACQUISITION_ATTACHMENT_CRON_MAX_DURATION_MS = "abc"
    const c = getAttachmentDownloadCronConfig()
    assert.equal(c.maxPerCompany, DEFAULT_ATTACHMENT_MAX_PER_COMPANY)
    assert.equal(c.maxPerRun, DEFAULT_ATTACHMENT_MAX_PER_RUN)
    assert.equal(c.maxCompaniesPerRun, DEFAULT_ATTACHMENT_MAX_COMPANIES_PER_RUN)
    assert.equal(c.maxDurationMs, DEFAULT_ATTACHMENT_CRON_MAX_DURATION_MS)
  })
})

describe("runAcquisitionAttachmentDownloadOrchestrator", () => {
  const events: Array<{ event: string; payload?: Record<string, unknown> }> = []

  beforeEach(() => {
    events.length = 0
    delete process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED
  })

  function logger(event: string, payload?: Record<string, unknown>) {
    events.push({ event, payload })
  }

  it("flag cron OFF → SKIPPED", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "false"
    const download = mockDownload(async () => ({ outcome: "STORED" }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: async () => {
          throw new Error("should not list")
        },
      }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-off",
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "CRON_DISABLED")
    assert.equal(result.runId, "run-off")
    assert.equal(download.calls.length, 0)
  })

  it("cron ON + master OFF → MASTER_DISABLED sans listing", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    let listed = false
    const download = mockDownload(async () => ({ outcome: "STORED" }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: async () => {
          listed = true
          return ["c1"]
        },
      }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-master-off",
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "MASTER_DISABLED")
    assert.equal(listed, false)
    assert.equal(download.calls.length, 0)
  })

  it("cron ON + download OFF → DOWNLOAD_CAPABILITY_DISABLED", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "false"
    const download = mockDownload(async () => ({ outcome: "STORED" }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({ companyIds: ["c1"] }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-cap-off",
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "DOWNLOAD_CAPABILITY_DISABLED")
    assert.equal(download.calls.length, 0)
  })

  it("runId créé une seule fois et identique dans tous les logs", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    let createCalls = 0
    const download = mockDownload(async () => ({ outcome: "STORED" }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: ["co-a"],
        byCompany: { "co-a": [candidate("co-a", "att-1")] },
      }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => {
        createCalls += 1
        return "run-unique"
      },
    })
    assert.equal(createCalls, 1)
    assert.equal(result.runId, "run-unique")
    for (const e of events) {
      assert.equal(e.payload?.runId, "run-unique")
    }
  })

  it("zéro tenant → SUCCESS", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({ companyIds: [] }),
      downloadAttachment: mockDownload(async () => ({ outcome: "STORED" })).fn,
      logger,
      createRunId: () => "run-empty",
    })
    assert.equal(result.status, "SUCCESS")
    assert.equal(result.companiesTotal, 0)
    assert.equal(result.globalStats.attempted, 0)
  })

  it("listing initial throw → FAILED structuré", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        listCompanyThrow: new Error("postgresql://user:password@host/db"),
      }),
      downloadAttachment: mockDownload(async () => ({ outcome: "STORED" })).fn,
      logger,
      createRunId: () => "run-list-fail",
    })
    assert.equal(result.status, "FAILED")
    assert.equal(result.errorCode, "ATTACHMENT_CANDIDATE_LISTING_FAILED")
    assert.equal(result.error?.message, "Unable to list attachment download candidates")
    const serialized = JSON.stringify(result)
    assert.ok(!serialized.includes("postgresql"))
    assert.ok(!serialized.includes("password"))
  })

  it("un tenant / une PJ → bon appel service", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const download = mockDownload(async () => ({ outcome: "STORED" }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: ["co-1"],
        byCompany: { "co-1": [candidate("co-1", "att-9")] },
      }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-one",
    })
    assert.equal(result.status, "SUCCESS")
    assert.deepEqual(download.calls, [{ companyId: "co-1", attachmentId: "att-9" }])
    assert.equal(result.globalStats.stored, 1)
  })

  it("plusieurs tenants traités séquentiellement", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const order: string[] = []
    const download = mockDownload(async ({ companyId }) => {
      order.push(companyId)
      return { outcome: "STORED" }
    })
    await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: ["co-a", "co-b"],
        byCompany: {
          "co-a": [candidate("co-a", "a1")],
          "co-b": [candidate("co-b", "b1")],
        },
      }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-seq",
    })
    assert.deepEqual(order, ["co-a", "co-b"])
  })

  it("tenant A échoue listing, tenant B continue", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    let listedB = false
    const repo: AttachmentDownloadOrchestratorRepository = {
      listCompanyIdsWithDiscoveredAttachments: async () => ["co-a", "co-b"],
      listDiscoveredAttachmentsForCompany: async ({ companyId }) => {
        if (companyId === "co-a") throw new Error("db down")
        listedB = true
        return [candidate("co-b", "b1")]
      },
    }
    const download = mockDownload(async () => ({ outcome: "STORED" }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: repo,
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-iso",
    })
    assert.ok(listedB)
    assert.equal(result.companiesFailed, 1)
    assert.equal(result.companiesSucceeded, 1)
    assert.equal(result.status, "PARTIAL")
    assert.deepEqual(download.calls, [{ companyId: "co-b", attachmentId: "b1" }])
  })

  it("agrégation de tous les outcomes", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const outcomes: AttachmentDownloadOutcome[] = [
      "STORED",
      "ALREADY_STORED",
      "ALREADY_IN_PROGRESS",
      "REJECTED",
      "FAILED",
      "SKIPPED",
    ]
    let i = 0
    const download = mockDownload(async () => ({ outcome: outcomes[i++]! }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: ["co"],
        byCompany: {
          co: outcomes.map((_, idx) => candidate("co", `att-${idx}`)),
        },
      }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-agg",
      config: {
        maxPerCompany: 20,
        maxPerRun: 100,
        maxCompaniesPerRun: 20,
        maxDurationMs: 240_000,
      },
    })
    assert.equal(result.globalStats.attempted, 6)
    assert.equal(result.globalStats.stored, 1)
    assert.equal(result.globalStats.alreadyStored, 1)
    assert.equal(result.globalStats.alreadyInProgress, 1)
    assert.equal(result.globalStats.rejected, 1)
    assert.equal(result.globalStats.failed, 1)
    assert.equal(result.globalStats.skipped, 1)
    assert.equal(result.status, "PARTIAL")
  })

  it("plafond per-company batch volontaire → SUCCESS sans PARTIAL auto", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const download = mockDownload(async () => ({ outcome: "STORED" }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: ["co"],
        byCompany: {
          co: [candidate("co", "1"), candidate("co", "2"), candidate("co", "3")],
        },
      }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-pc",
      config: {
        maxPerCompany: 2,
        maxPerRun: 100,
        maxCompaniesPerRun: 20,
        maxDurationMs: 240_000,
      },
    })
    assert.equal(download.calls.length, 2)
    assert.equal(result.status, "SUCCESS")
    assert.equal(result.budgetReached, undefined)
  })

  it("exactement maxPerRun PJ, aucune supplémentaire → SUCCESS", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const download = mockDownload(async () => ({ outcome: "STORED" }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: ["co"],
        byCompany: {
          co: [candidate("co", "1"), candidate("co", "2")],
        },
      }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-exact-run",
      config: {
        maxPerCompany: 20,
        maxPerRun: 2,
        maxCompaniesPerRun: 20,
        maxDurationMs: 240_000,
      },
    })
    assert.equal(result.status, "SUCCESS")
    assert.equal(result.budgetReached, undefined)
    assert.equal(download.calls.length, 2)
    assert.ok(!events.some((e) => e.event === "DOWNLOAD_BUDGET_REACHED"))
  })

  it("plafond global avec PJ supplémentaire → PARTIAL", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const download = mockDownload(async () => ({ outcome: "STORED" }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: ["co-a", "co-b"],
        byCompany: {
          "co-a": [candidate("co-a", "a1"), candidate("co-a", "a2")],
          "co-b": [candidate("co-b", "b1")],
        },
      }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-global",
      config: {
        maxPerCompany: 20,
        maxPerRun: 2,
        maxCompaniesPerRun: 20,
        maxDurationMs: 240_000,
      },
    })
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.budgetReached, "MAX_ATTACHMENTS_PER_RUN")
    assert.equal(download.calls.length, 2)
    assert.ok(events.some((e) => e.event === "DOWNLOAD_BUDGET_REACHED"))
  })

  it("exactement maxCompaniesPerRun sociétés, aucune 3e → SUCCESS", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const limitsSeen: number[] = []
    const download = mockDownload(async () => ({ outcome: "STORED" }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: {
        listCompanyIdsWithDiscoveredAttachments: async ({ limit }) => {
          limitsSeen.push(limit)
          return ["co-a", "co-b"].slice(0, limit)
        },
        listDiscoveredAttachmentsForCompany: async ({ companyId, limit }) =>
          [candidate(companyId, `${companyId}-1`)].slice(0, limit),
      },
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-cos-exact",
      config: {
        maxPerCompany: 20,
        maxPerRun: 100,
        maxCompaniesPerRun: 2,
        maxDurationMs: 240_000,
      },
    })
    assert.deepEqual(limitsSeen, [3])
    assert.equal(result.companiesTotal, 2)
    assert.equal(result.status, "SUCCESS")
    assert.equal(result.budgetReached, undefined)
    assert.ok(!events.some((e) => e.event === "DOWNLOAD_BUDGET_REACHED"))
  })

  it("overflow sociétés prouvé (limit+1) → PARTIAL / MAX_COMPANIES_PER_RUN", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const download = mockDownload(async () => ({ outcome: "STORED" }))
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: {
        listCompanyIdsWithDiscoveredAttachments: async ({ limit }) =>
          ["co-a", "co-b", "co-c"].slice(0, limit),
        listDiscoveredAttachmentsForCompany: async ({ companyId, limit }) =>
          [candidate(companyId, `${companyId}-1`)].slice(0, limit),
      },
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-cos-overflow",
      config: {
        maxPerCompany: 20,
        maxPerRun: 100,
        maxCompaniesPerRun: 2,
        maxDurationMs: 240_000,
      },
    })
    assert.equal(result.companiesTotal, 2)
    assert.equal(download.calls.length, 2)
    assert.ok(!download.calls.some((c) => c.companyId === "co-c"))
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.budgetReached, "MAX_COMPANIES_PER_RUN")
  })

  it("downloadAttachment throw → failed + PARTIAL + tenants suivants continuent", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const download = mockDownload(async ({ companyId }) => {
      if (companyId === "co-a") {
        throw Object.assign(new Error("postgresql://user:password@host/secret-stack"), {
          name: "SyntheticDownloadError",
        })
      }
      return { outcome: "STORED" }
    })
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: ["co-a", "co-b"],
        byCompany: {
          "co-a": [candidate("co-a", "a1")],
          "co-b": [candidate("co-b", "b1")],
        },
      }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-throw",
      config: {
        maxPerCompany: 20,
        maxPerRun: 100,
        maxCompaniesPerRun: 20,
        maxDurationMs: 240_000,
      },
    })
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.globalStats.failed, 1)
    assert.equal(result.globalStats.stored, 1)
    assert.equal(result.companiesPartial, 1)
    assert.equal(result.companiesSucceeded, 1)
    assert.deepEqual(download.calls.map((c) => c.companyId), ["co-a", "co-b"])
    const threw = events.find((e) => e.event === "DOWNLOAD_ATTACHMENT_THREW")
    assert.ok(threw)
    assert.equal(threw!.payload?.runId, "run-throw")
    assert.equal(threw!.payload?.companyId, "co-a")
    assert.equal(threw!.payload?.attachmentId, "a1")
    assert.equal(threw!.payload?.internalCode, "SyntheticDownloadError")
    const serialized = JSON.stringify({ result, events })
    assert.ok(!serialized.includes("postgresql"))
    assert.ok(!serialized.includes("password"))
    assert.ok(!serialized.includes("secret-stack"))
  })

  it("runId jamais passé au repository ni au download", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const repoCalls: unknown[] = []
    const download = mockDownload(async (input) => {
      repoCalls.push({ kind: "download", input })
      return { outcome: "STORED" }
    })
    await runAcquisitionAttachmentDownloadOrchestrator({
      repository: {
        listCompanyIdsWithDiscoveredAttachments: async (input) => {
          repoCalls.push({ kind: "listCompanies", input })
          return ["co"]
        },
        listDiscoveredAttachmentsForCompany: async (input) => {
          repoCalls.push({ kind: "listAttachments", input })
          return [candidate("co", "att-1")]
        },
      },
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-no-persist",
    })
    const serialized = JSON.stringify(repoCalls)
    assert.ok(!serialized.includes("run-no-persist"))
    assert.ok(!serialized.includes("runId"))
  })

  it("budget temps avant prochaine PJ → PARTIAL sans annuler PJ en cours", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    let t = 0
    const clock = () => new Date(t)
    let inFlight = 0
    let maxInFlight = 0
    const download = mockDownload(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      t += 50
      inFlight -= 1
      return { outcome: "STORED" }
    })
    const result = await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: ["co"],
        byCompany: {
          co: [candidate("co", "1"), candidate("co", "2"), candidate("co", "3")],
        },
      }),
      downloadAttachment: download.fn,
      logger,
      clock,
      createRunId: () => "run-time",
      config: {
        maxPerCompany: 20,
        maxPerRun: 100,
        maxCompaniesPerRun: 20,
        maxDurationMs: 60,
      },
    })
    assert.equal(maxInFlight, 1)
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.budgetReached, "MAX_DURATION_MS")
    assert.ok(download.calls.length >= 1)
    assert.ok(download.calls.length < 3)
  })

  it("logs sans storagePublicId ni secret", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: ["co"],
        byCompany: { co: [candidate("co", "att")] },
      }),
      downloadAttachment: mockDownload(async () => ({ outcome: "STORED" })).fn,
      logger,
      createRunId: () => "run-safe",
    })
    const serialized = JSON.stringify(events)
    assert.ok(!serialized.includes("storagePublicId"))
    assert.ok(!serialized.includes("cloudinary"))
    assert.ok(!serialized.includes("Bearer"))
  })

  it("aucun appel Gmail/Cloudinary direct — uniquement downloadAttachment", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const download = mockDownload(async () => ({ outcome: "ALREADY_IN_PROGRESS" }))
    await runAcquisitionAttachmentDownloadOrchestrator({
      repository: mockRepo({
        companyIds: ["co"],
        byCompany: { co: [candidate("co", "att")] },
      }),
      downloadAttachment: download.fn,
      logger,
      createRunId: () => "run-port",
    })
    assert.equal(download.calls.length, 1)
  })
})
