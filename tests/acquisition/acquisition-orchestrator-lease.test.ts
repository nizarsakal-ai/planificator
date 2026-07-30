/**
 * PLAN-ACQ-V2-001 — Tests lease orchestrateur (sémantique atomique in-memory).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { InMemoryAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"
import { getAcquisitionOrchestratorConfig } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"

describe("acquisition-orchestrator-lease", () => {
  it("lease disponible → ACQUIRED", async () => {
    const repo = new InMemoryAcquisitionOrchestratorLeaseRepository()
    const r = await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-a",
      leaseTtlMs: 60_000,
    })
    assert.equal(r.outcome, "ACQUIRED")
    assert.equal(repo.peek(ACQUISITION_ORCHESTRATOR_LEASE_KEY)?.ownerRunId, "run-a")
  })

  it("lease non expirée → ALREADY_RUNNING", async () => {
    const repo = new InMemoryAcquisitionOrchestratorLeaseRepository()
    await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-a",
      leaseTtlMs: 60_000,
    })
    const r = await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-b",
      leaseTtlMs: 60_000,
    })
    assert.equal(r.outcome, "ALREADY_RUNNING")
    assert.equal(repo.peek(ACQUISITION_ORCHESTRATOR_LEASE_KEY)?.ownerRunId, "run-a")
  })

  it("lease expirée → reprise par un nouveau runId", async () => {
    const repo = new InMemoryAcquisitionOrchestratorLeaseRepository()
    let t = Date.parse("2026-07-29T10:00:00.000Z")
    repo.nowFn = () => new Date(t)
    await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-a",
      leaseTtlMs: 60_000,
    })
    t += 61_000
    const r = await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-b",
      leaseTtlMs: 60_000,
    })
    assert.equal(r.outcome, "ACQUIRED")
    assert.equal(repo.peek(ACQUISITION_ORCHESTRATOR_LEASE_KEY)?.ownerRunId, "run-b")
  })

  it("owner set + expires null → ALREADY_RUNNING (prédicat strict)", async () => {
    const repo = new InMemoryAcquisitionOrchestratorLeaseRepository()
    repo.seedCorrupt(ACQUISITION_ORCHESTRATOR_LEASE_KEY, "run-corrupt")
    const r = await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-b",
      leaseTtlMs: 60_000,
    })
    assert.equal(r.outcome, "ALREADY_RUNNING")
  })

  it("release avec mauvais ownerRunId → aucune libération", async () => {
    const repo = new InMemoryAcquisitionOrchestratorLeaseRepository()
    await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-a",
      leaseTtlMs: 60_000,
    })
    const rel = await repo.release({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-other",
    })
    assert.equal(rel.outcome, "NOT_OWNER")
    assert.equal(repo.peek(ACQUISITION_ORCHESTRATOR_LEASE_KEY)?.ownerRunId, "run-a")
  })

  it("release propriétaire → libre puis ré-acquérable", async () => {
    const repo = new InMemoryAcquisitionOrchestratorLeaseRepository()
    await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-a",
      leaseTtlMs: 60_000,
    })
    const rel = await repo.release({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-a",
    })
    assert.equal(rel.outcome, "RELEASED")
    const again = await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-c",
      leaseTtlMs: 60_000,
    })
    assert.equal(again.outcome, "ACQUIRED")
  })

  it("assertOwned après steal → NOT_OWNER", async () => {
    const repo = new InMemoryAcquisitionOrchestratorLeaseRepository()
    let t = Date.parse("2026-07-29T10:00:00.000Z")
    repo.nowFn = () => new Date(t)
    await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-a",
      leaseTtlMs: 10_000,
    })
    t += 11_000
    await repo.acquire({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-b",
      leaseTtlMs: 60_000,
    })
    const a = await repo.assertOwned({
      key: ACQUISITION_ORCHESTRATOR_LEASE_KEY,
      ownerRunId: "run-a",
    })
    assert.equal(a.outcome, "NOT_OWNER")
  })

  it("config : leaseTtlMs >= maxDurationMs + safetyMargin", () => {
    process.env.ACQUISITION_ORCHESTRATOR_MAX_DURATION_MS = "500000"
    process.env.ACQUISITION_ORCHESTRATOR_SAFETY_MARGIN_MS = "5000"
    process.env.ACQUISITION_ORCHESTRATOR_LEASE_TTL_MS = "1000"
    const cfg = getAcquisitionOrchestratorConfig()
    assert.ok(cfg.leaseTtlMs >= cfg.maxDurationMs + cfg.safetyMarginMs)
    delete process.env.ACQUISITION_ORCHESTRATOR_MAX_DURATION_MS
    delete process.env.ACQUISITION_ORCHESTRATOR_SAFETY_MARGIN_MS
    delete process.env.ACQUISITION_ORCHESTRATOR_LEASE_TTL_MS
  })
})
