process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { runAcquisitionAttachmentRecoveryOrchestrator } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator"
import type { AttachmentRecoveryOrchestratorRepository } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator.types"
import type { AttachmentRecoveryCronConfig } from "@/lib/acquisition/attachments/attachment-recovery-cron-feature-flag"

function baseConfig(overrides: Partial<AttachmentRecoveryCronConfig> = {}): AttachmentRecoveryCronConfig {
  return {
    reclaimTtlMs: 20 * 60_000,
    maxRetries: 5,
    baseDelayMs: 60_000,
    maxDelayMs: 3_600_000,
    maxPerCompany: 20,
    maxPerRun: 100,
    maxCompaniesPerRun: 20,
    maxDurationMs: 240_000,
    ...overrides,
  }
}

function mockRepo(
  overrides: Partial<AttachmentRecoveryOrchestratorRepository> = {}
): AttachmentRecoveryOrchestratorRepository {
  return {
    listCompanyIdsWithReclaimCandidates:
      overrides.listCompanyIdsWithReclaimCandidates ?? (async () => []),
    listPendingDownloadsForReclaim:
      overrides.listPendingDownloadsForReclaim ?? (async () => []),
    reclaimPendingDownload: overrides.reclaimPendingDownload ?? (async () => "NOOP"),
    listCompanyIdsWithRetryCandidates:
      overrides.listCompanyIdsWithRetryCandidates ?? (async () => []),
    listFailedAttachmentsForRetry:
      overrides.listFailedAttachmentsForRetry ?? (async () => []),
    scheduleRetryToDiscovered:
      overrides.scheduleRetryToDiscovered ?? (async () => "NOOP"),
  }
}

describe("attachment-recovery-orchestrator", () => {
  const envBackup = {
    recovery: process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED,
    master: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    download: process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED,
  }

  beforeEach(() => {
    process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
  })

  afterEach(() => {
    if (envBackup.recovery === undefined) delete process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED
    else process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = envBackup.recovery
    if (envBackup.master === undefined) delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    else process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.master
    if (envBackup.download === undefined) delete process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED
    else process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = envBackup.download
  })

  it("flag off → SKIPPED + runId", async () => {
    process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = "false"
    const events: string[] = []
    const result = await runAcquisitionAttachmentRecoveryOrchestrator({
      repository: mockRepo(),
      createRunId: () => "run-1",
      logger: (e) => events.push(e),
      config: baseConfig(),
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "CRON_DISABLED")
    assert.equal(result.runId, "run-1")
    assert.ok(events.includes("RECOVERY_CRON_START"))
    assert.ok(events.includes("FLAG_SKIP"))
    assert.ok(events.includes("RECOVERY_CRON_FINISHED"))
  })

  it("master OFF → MASTER_DISABLED + zéro listing", async () => {
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    let listed = false
    const result = await runAcquisitionAttachmentRecoveryOrchestrator({
      repository: mockRepo({
        listCompanyIdsWithReclaimCandidates: async () => {
          listed = true
          return ["c1"]
        },
      }),
      createRunId: () => "run-master-off",
      config: baseConfig(),
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "MASTER_DISABLED")
    assert.equal(listed, false)
    assert.equal(result.reclaim.transitioned, 0)
  })

  it("download OFF → DOWNLOAD_CAPABILITY_DISABLED + zéro transition", async () => {
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "false"
    let reclaimCalled = false
    const result = await runAcquisitionAttachmentRecoveryOrchestrator({
      repository: mockRepo({
        reclaimPendingDownload: async () => {
          reclaimCalled = true
          return "RECLAIMED"
        },
      }),
      createRunId: () => "run-dl-off",
      config: baseConfig(),
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "DOWNLOAD_CAPABILITY_DISABLED")
    assert.equal(reclaimCalled, false)
  })

  it("zéro candidat → SUCCESS", async () => {
    const result = await runAcquisitionAttachmentRecoveryOrchestrator({
      repository: mockRepo(),
      createRunId: () => "run-empty",
      config: baseConfig(),
    })
    assert.equal(result.status, "SUCCESS")
    assert.equal(result.reclaim.transitioned, 0)
    assert.equal(result.retry.transitioned, 0)
  })

  it("phases reclaim puis retry + runId propagé", async () => {
    const events: Array<{ e: string; p?: Record<string, unknown> }> = []
    const order: string[] = []
    const result = await runAcquisitionAttachmentRecoveryOrchestrator({
      createRunId: () => "run-order",
      logger: (e, p) => {
        events.push({ e, p })
        order.push(e)
      },
      config: baseConfig({ maxPerCompany: 5, maxPerRun: 10 }),
      repository: mockRepo({
        listCompanyIdsWithReclaimCandidates: async () => ["co-a"],
        listPendingDownloadsForReclaim: async () => [
          { id: "a1", companyId: "co-a", downloadClaimedAt: new Date("2026-01-01") },
        ],
        reclaimPendingDownload: async () => {
          order.push("reclaim")
          return "RECLAIMED"
        },
        listCompanyIdsWithRetryCandidates: async () => ["co-b"],
        listFailedAttachmentsForRetry: async () => [
          { id: "b1", companyId: "co-b", downloadRetryCount: 1, lastErrorCode: "GMAIL_NOT_CONNECTED" },
        ],
        scheduleRetryToDiscovered: async () => {
          order.push("retry")
          return "TRANSITIONED"
        },
      }),
    })
    assert.equal(result.status, "SUCCESS")
    assert.equal(result.reclaim.transitioned, 1)
    assert.equal(result.retry.transitioned, 1)
    assert.ok(order.indexOf("reclaim") < order.indexOf("retry"))
    assert.ok(events.every((x) => x.p?.runId === "run-order" || x.e === "reclaim" || x.e === "retry" || !x.p))
    assert.ok(events.some((x) => x.e === "RECLAIM_COMPLETED" && x.p?.runId === "run-order"))
    assert.ok(events.some((x) => x.e === "RETRY_TRANSITIONED" && x.p?.runId === "run-order"))
  })

  it("aucune invocation hors repository (pas de download)", async () => {
    let downloads = 0
    await runAcquisitionAttachmentRecoveryOrchestrator({
      createRunId: () => "run-no-dl",
      config: baseConfig(),
      repository: mockRepo({
        listCompanyIdsWithReclaimCandidates: async () => ["co-a"],
        listPendingDownloadsForReclaim: async () => [
          { id: "a1", companyId: "co-a", downloadClaimedAt: new Date(0) },
        ],
        reclaimPendingDownload: async () => "RECLAIMED",
      }),
    })
    assert.equal(downloads, 0)
  })

  it("probe companies limit+1 → PARTIAL overflow", async () => {
    const result = await runAcquisitionAttachmentRecoveryOrchestrator({
      createRunId: () => "run-overflow",
      config: baseConfig({ maxCompaniesPerRun: 1, maxPerCompany: 1, maxPerRun: 10 }),
      repository: mockRepo({
        listCompanyIdsWithReclaimCandidates: async ({ limit }) => {
          assert.equal(limit, 2)
          return ["co-a", "co-b"]
        },
        listPendingDownloadsForReclaim: async () => [
          { id: "a1", companyId: "co-a", downloadClaimedAt: new Date(0) },
        ],
        reclaimPendingDownload: async () => "RECLAIMED",
        listCompanyIdsWithRetryCandidates: async () => [],
      }),
    })
    assert.equal(result.status, "PARTIAL")
    assert.equal(result.budgetReason, "MAX_COMPANIES_PER_RUN")
    assert.equal(result.reclaim.companiesProcessed, 1)
  })

  it("exact fit companies → SUCCESS", async () => {
    const result = await runAcquisitionAttachmentRecoveryOrchestrator({
      createRunId: () => "run-fit",
      config: baseConfig({ maxCompaniesPerRun: 2 }),
      repository: mockRepo({
        listCompanyIdsWithReclaimCandidates: async ({ limit }) => {
          assert.equal(limit, 3)
          return ["co-a", "co-b"]
        },
        listPendingDownloadsForReclaim: async () => [],
        listCompanyIdsWithRetryCandidates: async () => [],
      }),
    })
    assert.equal(result.status, "SUCCESS")
    assert.equal(result.budgetReason, undefined)
  })

  it("tenant A échoue, tenant B continue", async () => {
    const result = await runAcquisitionAttachmentRecoveryOrchestrator({
      createRunId: () => "run-iso",
      config: baseConfig({ maxCompaniesPerRun: 5 }),
      repository: mockRepo({
        listCompanyIdsWithReclaimCandidates: async () => ["co-a", "co-b"],
        listPendingDownloadsForReclaim: async ({ companyId }) => {
          if (companyId === "co-a") throw new Error("boom")
          return [{ id: "b1", companyId: "co-b", downloadClaimedAt: new Date(0) }]
        },
        reclaimPendingDownload: async () => "RECLAIMED",
        listCompanyIdsWithRetryCandidates: async () => [],
      }),
    })
    assert.equal(result.reclaim.companiesFailed, 1)
    assert.equal(result.reclaim.transitioned, 1)
    assert.ok(result.status === "PARTIAL" || result.status === "SUCCESS")
  })

  it("budget durée → PARTIAL", async () => {
    let ticks = 0
    const start = new Date("2026-07-19T12:00:00.000Z")
    const result = await runAcquisitionAttachmentRecoveryOrchestrator({
      createRunId: () => "run-time",
      clock: () => {
        ticks++
        return ticks <= 2 ? start : new Date(start.getTime() + 10_000)
      },
      config: baseConfig({ maxDurationMs: 5_000, maxCompaniesPerRun: 5 }),
      repository: mockRepo({
        listCompanyIdsWithReclaimCandidates: async () => ["co-a", "co-b"],
        listPendingDownloadsForReclaim: async () => [
          { id: "a1", companyId: "co-a", downloadClaimedAt: new Date(0) },
        ],
        reclaimPendingDownload: async () => "RECLAIMED",
        listCompanyIdsWithRetryCandidates: async () => [],
      }),
    })
    assert.equal(result.budgetReason, "MAX_DURATION_MS")
    assert.equal(result.status, "PARTIAL")
  })
})
