process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { handleAcquisitionAttachmentRecoveryCron } from "@/lib/acquisition/attachments/attachment-recovery-cron.handler"
import type { AttachmentRecoveryCronRunResult } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator.types"
import { emptyPhaseStats } from "@/lib/acquisition/attachments/attachment-recovery-orchestrator.types"

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

describe("attachment-recovery-cron.route", () => {
  const secretBackup = process.env.CRON_SECRET

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret"
  })

  afterEach(() => {
    if (secretBackup === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = secretBackup
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

  it("succès", async () => {
    const res = await handleAcquisitionAttachmentRecoveryCron(
      new Request("http://localhost/api/cron/acquisition-attachment-recovery", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      { runOrchestrator: async () => okResult() }
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as AttachmentRecoveryCronRunResult
    assert.equal(body.status, "SUCCESS")
    assert.equal(body.runId, "run-route")
  })

  it("flag off via orchestrator SKIPPED", async () => {
    const res = await handleAcquisitionAttachmentRecoveryCron(
      new Request("http://localhost/api/cron/acquisition-attachment-recovery", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      {
        runOrchestrator: async () => ({
          ...okResult(),
          status: "SKIPPED",
          skipReason: "CRON_DISABLED",
        }),
      }
    )
    assert.equal(res.status, 200)
    const body = (await res.json()) as AttachmentRecoveryCronRunResult
    assert.equal(body.status, "SKIPPED")
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
