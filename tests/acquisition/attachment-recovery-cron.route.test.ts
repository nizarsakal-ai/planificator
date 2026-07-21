process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { handleAcquisitionAttachmentRecoveryCron } from "@/lib/acquisition/attachments/attachment-recovery-cron.handler"
import { runAcquisitionAttachmentRecoveryOrchestrator } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator"
import type { AttachmentRecoveryCronRunResult } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator.types"
import { emptyPhaseStats } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator.types"
import type { AttachmentRecoveryOrchestratorRepository } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator.types"

function okResult(): AttachmentRecoveryCronRunResult {
  return {
    status: "SUCCESS",
    runId: "run-route",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    reclaim: emptyPhaseStats(),
    retry: emptyPhaseStats(),
    companies: [],
    config: {
      reclaimTtlMs: 1,
      maxRetries: 5,
      maxPerCompany: 20,
      maxPerRun: 100,
      maxCompaniesPerRun: 20,
      maxDurationMs: 240000,
    },
  }
}

function silentRepo(): AttachmentRecoveryOrchestratorRepository {
  return {
    listCompanyIdsWithReclaimCandidates: async () => {
      throw new Error("should not list reclaim")
    },
    listPendingDownloadsForReclaim: async () => {
      throw new Error("should not list pending")
    },
    listCompanyIdsWithRetryCandidates: async () => {
      throw new Error("should not list retry companies")
    },
    listFailedAttachmentsForRetry: async () => {
      throw new Error("should not list failed")
    },
    reclaimPendingDownload: async () => {
      throw new Error("should not reclaim")
    },
    scheduleRetryToDiscovered: async () => {
      throw new Error("should not retry")
    },
  }
}

describe("attachment-recovery-cron.route", () => {
  const secretBackup = process.env.CRON_SECRET
  const envBackup = {
    recovery: process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED,
    master: process.env.PLANIFICATOR_ACQUISITION_ENABLED,
    download: process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED,
  }

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret"
    delete process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    delete process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED
  })

  afterEach(() => {
    if (secretBackup === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = secretBackup
    if (envBackup.recovery === undefined) delete process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED
    else process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = envBackup.recovery
    if (envBackup.master === undefined) delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    else process.env.PLANIFICATOR_ACQUISITION_ENABLED = envBackup.master
    if (envBackup.download === undefined) delete process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED
    else process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = envBackup.download
  })

  it("401 sans secret", async () => {
    const res = await handleAcquisitionAttachmentRecoveryCron(
      new Request("http://localhost/api/cron/acquisition-attachment-recovery")
    )
    assert.equal(res.status, 401)
  })

  it("401 secret incorrect", async () => {
    const res = await handleAcquisitionAttachmentRecoveryCron(
      new Request("http://localhost/api/cron/acquisition-attachment-recovery", {
        headers: { authorization: "Bearer wrong" },
      })
    )
    assert.equal(res.status, 401)
  })

  it("cron OFF → CRON_DISABLED via vrai gate", async () => {
    process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = "false"
    const res = await handleAcquisitionAttachmentRecoveryCron(
      new Request("http://localhost/api/cron/acquisition-attachment-recovery", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      {
        runOrchestrator: () =>
          runAcquisitionAttachmentRecoveryOrchestrator({
            repository: silentRepo(),
            createRunId: () => "route-cron-off",
          }),
      }
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as AttachmentRecoveryCronRunResult
    assert.equal(body.status, "SKIPPED")
    assert.equal(body.skipReason, "CRON_DISABLED")
  })

  it("master OFF → MASTER_DISABLED + zéro sélection", async () => {
    process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = "true"
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    const res = await handleAcquisitionAttachmentRecoveryCron(
      new Request("http://localhost/api/cron/acquisition-attachment-recovery", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      {
        runOrchestrator: () =>
          runAcquisitionAttachmentRecoveryOrchestrator({
            repository: silentRepo(),
            createRunId: () => "route-master-off",
          }),
      }
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as AttachmentRecoveryCronRunResult
    assert.equal(body.status, "SKIPPED")
    assert.equal(body.skipReason, "MASTER_DISABLED")
    assert.equal(body.reclaim.transitioned, 0)
    assert.equal(body.retry.transitioned, 0)
  })

  it("download capability OFF → DOWNLOAD_CAPABILITY_DISABLED + zéro transition", async () => {
    process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "false"
    const res = await handleAcquisitionAttachmentRecoveryCron(
      new Request("http://localhost/api/cron/acquisition-attachment-recovery", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      {
        runOrchestrator: () =>
          runAcquisitionAttachmentRecoveryOrchestrator({
            repository: silentRepo(),
            createRunId: () => "route-dl-off",
          }),
      }
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as AttachmentRecoveryCronRunResult
    assert.equal(body.status, "SKIPPED")
    assert.equal(body.skipReason, "DOWNLOAD_CAPABILITY_DISABLED")
    assert.equal(body.reclaim.transitioned, 0)
    assert.equal(body.retry.transitioned, 0)
  })

  it("flags valides → recovery appelé une fois", async () => {
    process.env.ACQUISITION_ATTACHMENT_RECOVERY_CRON_ENABLED = "true"
    process.env.PLANIFICATOR_ACQUISITION_ENABLED = "true"
    process.env.ACQUISITION_ATTACHMENT_DOWNLOAD_ENABLED = "true"
    let calls = 0
    const res = await handleAcquisitionAttachmentRecoveryCron(
      new Request("http://localhost/api/cron/acquisition-attachment-recovery", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      {
        runOrchestrator: async () => {
          calls += 1
          return okResult()
        },
      }
    )
    assert.equal(res.status, 200)
    assert.equal(calls, 1)
    const body = (await res.json()) as AttachmentRecoveryCronRunResult
    assert.equal(body.status, "SUCCESS")
    assert.equal(body.runId, "run-route")
  })

  it("erreur sanitizée — aucun secret dans JSON", async () => {
    const res = await handleAcquisitionAttachmentRecoveryCron(
      new Request("http://localhost/api/cron/acquisition-attachment-recovery", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      {
        runOrchestrator: async () => {
          throw new Error("DATABASE_URL=secret gmail-token=xyz")
        },
      }
    )
    assert.equal(res.status, 500)
    const text = await res.text()
    assert.ok(!text.includes("DATABASE_URL"))
    assert.ok(!text.includes("gmail-token"))
    assert.ok(!text.includes("secret"))
    const body = JSON.parse(text) as { code: string }
    assert.equal(body.code, "ATTACHMENT_RECOVERY_CRON_FAILED")
  })
})
