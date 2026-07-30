/**
 * PLAN-ACQ-V2-001 — Tests route/handler orchestrateur.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, it } from "node:test"
import { handleAcquisitionOrchestratorCron } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.handler"
import { InMemoryAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import {
  createDefaultStubStepRunners,
  createUnwiredStepRunners,
  runAcquisitionOrchestrator,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.service"
import { ORCHESTRATOR_STEP_KEYS } from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"
import { maxDuration } from "@/app/api/cron/acquisition-orchestrator/route"

const CRON_SECRET = "test-cron-secret-orchestrator"
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

function request(authHeader?: string): Request {
  return new Request("http://localhost/api/cron/acquisition-orchestrator", {
    method: "GET",
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

describe("handleAcquisitionOrchestratorCron", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
    delete process.env.ACQUISITION_ORCHESTRATOR_CRON_ENABLED
    delete process.env.PLANIFICATOR_ACQUISITION_ENABLED
    delete process.env.ACQUISITION_ORCHESTRATOR_ALLOW_STUBS
  })

  it("auth absente → 401", async () => {
    const res = await handleAcquisitionOrchestratorCron(request())
    assert.equal(res.status, 401)
  })

  it("CRON_SECRET unset → 401", async () => {
    delete process.env.CRON_SECRET
    const res = await handleAcquisitionOrchestratorCron(
      request("Bearer anything")
    )
    assert.equal(res.status, 401)
  })

  it("auth incorrecte → 401", async () => {
    const res = await handleAcquisitionOrchestratorCron(request("Bearer wrong"))
    assert.equal(res.status, 401)
  })

  it("flag OFF → 200 SKIPPED + runId", async () => {
    const res = await handleAcquisitionOrchestratorCron(request(`Bearer ${CRON_SECRET}`), {
      createRunId: () => "fixed-run-id",
      run: async ({ runId }) =>
        runAcquisitionOrchestrator({
          runId,
          leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
          resolveGate: () => ({ allowed: false, skipReason: "CRON_DISABLED" }),
        }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.runId, "fixed-run-id")
    assert.equal(body.skipReason, "CRON_DISABLED")
  })

  it("unwired path → FAILED WORKERS_NOT_WIRED (pas SUCCESS stub)", async () => {
    const res = await handleAcquisitionOrchestratorCron(request(`Bearer ${CRON_SECRET}`), {
      createRunId: () => "run-unwired",
      run: async ({ runId }) =>
        runAcquisitionOrchestrator({
          runId,
          leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
          resolveGate: () => ({ allowed: true }),
          steps: createUnwiredStepRunners(),
          config: {
            maxDurationMs: 60_000,
            safetyMarginMs: 1_000,
            leaseTtlMs: 120_000,
          },
        }),
    })
    const body = await res.json()
    assert.equal(body.status, "FAILED")
    assert.equal(body.steps.gmailSync.error.code, "WORKERS_NOT_WIRED")
  })

  it("stubs explicites → SUCCESS", async () => {
    const res = await handleAcquisitionOrchestratorCron(request(`Bearer ${CRON_SECRET}`), {
      createRunId: () => "run-ok",
      run: async ({ runId }) =>
        runAcquisitionOrchestrator({
          runId,
          leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
          resolveGate: () => ({ allowed: true }),
          steps: createDefaultStubStepRunners(),
          config: {
            maxDurationMs: 60_000,
            safetyMarginMs: 1_000,
            leaseTtlMs: 120_000,
          },
        }),
    })
    assert.equal((await res.json()).status, "SUCCESS")
  })

  it("maxDuration = 300 ; route hors vercel.json", () => {
    assert.equal(maxDuration, 300)
    assert.equal(
      existsSync(join(ROOT, "src/app/api/cron/acquisition-orchestrator/route.ts")),
      true
    )
    const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as {
      crons: Array<{ path: string }>
    }
    assert.equal(
      vercel.crons.map((c) => c.path).includes("/api/cron/acquisition-orchestrator"),
      false
    )
    for (const key of ORCHESTRATOR_STEP_KEYS) assert.ok(key)
  })
})
