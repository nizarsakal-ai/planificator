/**
 * PLAN-ACQ-V2-001 — Tests service orchestrateur.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { InMemoryAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import {
  createDefaultStubStepRunners,
  createUnwiredStepRunners,
  runAcquisitionOrchestrator,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.service"
import {
  ORCHESTRATOR_STEP_KEYS,
  type AcquisitionOrchestratorStepRunners,
  type OrchestratorStepKey,
} from "@/lib/acquisition/orchestrator/acquisition-orchestrator.types"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"

function trackingRunners(
  onCall: (step: OrchestratorStepKey) => void,
  overrides: Partial<
    Record<OrchestratorStepKey, AcquisitionOrchestratorStepRunners[OrchestratorStepKey]>
  > = {}
): AcquisitionOrchestratorStepRunners {
  const base = createDefaultStubStepRunners()
  const wrap = (key: OrchestratorStepKey) => {
    const inner = overrides[key] ?? base[key]
    return async (ctx: { runId: string; remainingMs: number }) => {
      onCall(key)
      return inner(ctx)
    }
  }
  return {
    gmailSync: wrap("gmailSync"),
    attachmentRecovery: wrap("attachmentRecovery"),
    attachmentDownload: wrap("attachmentDownload"),
    contentFetch: wrap("contentFetch"),
    extraction: wrap("extraction"),
  }
}

const cfg = {
  maxDurationMs: 60_000,
  safetyMarginMs: 1_000,
  leaseTtlMs: 120_000,
}

describe("runAcquisitionOrchestrator", () => {
  it("flag OFF → SKIPPED/CRON_DISABLED", async () => {
    const result = await runAcquisitionOrchestrator({
      runId: "run-skip-cron",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: false, skipReason: "CRON_DISABLED" }),
    })
    assert.equal(result.status, "SKIPPED")
    assert.equal(result.skipReason, "CRON_DISABLED")
  })

  it("master OFF → SKIPPED/MASTER_DISABLED", async () => {
    const result = await runAcquisitionOrchestrator({
      runId: "run-skip-master",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: false, skipReason: "MASTER_DISABLED" }),
    })
    assert.equal(result.skipReason, "MASTER_DISABLED")
  })

  it("lease déjà détenue → SKIPPED/ALREADY_RUNNING", async () => {
    const lease = new InMemoryAcquisitionOrchestratorLeaseRepository()
    await lease.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "other",
      leaseTtlMs: 60_000,
    })
    const result = await runAcquisitionOrchestrator({
      runId: "run-blocked",
      leaseRepository: lease,
      resolveGate: () => ({ allowed: true }),
      config: cfg,
    })
    assert.equal(result.skipReason, "ALREADY_RUNNING")
  })

  it("unwired runners → FAILED (pas de faux SUCCESS)", async () => {
    const result = await runAcquisitionOrchestrator({
      runId: "run-unwired",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: true }),
      steps: createUnwiredStepRunners(),
      config: cfg,
    })
    assert.equal(result.status, "FAILED")
    assert.equal(result.steps.gmailSync.error?.code, "WORKERS_NOT_WIRED")
  })

  it("ordre exact des cinq étapes", async () => {
    const called: OrchestratorStepKey[] = []
    const result = await runAcquisitionOrchestrator({
      runId: "run-order",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: true }),
      steps: trackingRunners((s) => called.push(s)),
      config: cfg,
    })
    assert.deepEqual(called, [...ORCHESTRATOR_STEP_KEYS])
    assert.equal(result.status, "SUCCESS")
  })

  it("continuation après échec d’une étape", async () => {
    const called: OrchestratorStepKey[] = []
    const result = await runAcquisitionOrchestrator({
      runId: "run-continue",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: true }),
      steps: trackingRunners((s) => called.push(s), {
        gmailSync: async () => ({
          status: "FAILED",
          error: { code: "GMAIL_UNAVAILABLE", message: "Gmail indisponible" },
        }),
      }),
      config: cfg,
    })
    assert.deepEqual(called, [...ORCHESTRATOR_STEP_KEYS])
    assert.equal(result.status, "PARTIAL")
  })

  it("budget épuisé → NOT_RUN/BUDGET_EXHAUSTED", async () => {
    let t = Date.parse("2026-07-29T12:00:00.000Z")
    const called: OrchestratorStepKey[] = []
    const result = await runAcquisitionOrchestrator({
      runId: "run-budget",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: true }),
      now: () => new Date(t),
      steps: trackingRunners((s) => {
        called.push(s)
        t += 50_000
      }),
      config: {
        maxDurationMs: 40_000,
        safetyMarginMs: 5_000,
        leaseTtlMs: 120_000,
      },
    })
    assert.equal(called.length, 1)
    assert.equal(result.steps.extraction.skipReason, "BUDGET_EXHAUSTED")
    assert.equal(result.status, "PARTIAL")
  })

  it("lease stolen mid-run → stop + LEASE_STOLEN", async () => {
    const lease = new InMemoryAcquisitionOrchestratorLeaseRepository()
    const result = await runAcquisitionOrchestrator({
      runId: "run-stolen",
      leaseRepository: lease,
      resolveGate: () => ({ allowed: true }),
      steps: trackingRunners(() => {}, {
        gmailSync: async () => {
          lease.forceOwner(ACQUISITION_ORCHESTRATOR_LEASE_KEY, "thief", 60_000)
          return { status: "SUCCESS", result: { stub: true } }
        },
      }),
      config: cfg,
    })
    assert.equal(result.steps.attachmentRecovery.skipReason, "LEASE_STOLEN")
    assert.equal(result.steps.extraction.skipReason, "LEASE_STOLEN")
    assert.equal(result.status, "PARTIAL")
  })

  it("release throw → PARTIAL + leaseReleaseFailed", async () => {
    const lease = new InMemoryAcquisitionOrchestratorLeaseRepository()
    const orig = lease.release.bind(lease)
    lease.release = async () => {
      throw new Error("db-down")
    }
    const result = await runAcquisitionOrchestrator({
      runId: "run-rel-fail",
      leaseRepository: lease,
      resolveGate: () => ({ allowed: true }),
      steps: createDefaultStubStepRunners(),
      config: cfg,
    })
    assert.equal(result.leaseReleaseFailed, true)
    assert.equal(result.status, "PARTIAL")
    void orig
  })

  it("toutes les étapes présentes", async () => {
    const result = await runAcquisitionOrchestrator({
      runId: "run-shape",
      leaseRepository: new InMemoryAcquisitionOrchestratorLeaseRepository(),
      resolveGate: () => ({ allowed: false, skipReason: "CRON_DISABLED" }),
    })
    assert.deepEqual(Object.keys(result.steps).sort(), [...ORCHESTRATOR_STEP_KEYS].sort())
  })
})
