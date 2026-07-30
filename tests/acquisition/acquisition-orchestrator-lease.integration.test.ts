/**
 * PLAN-ACQ-V2-001 — Test intégration lease (PostgreSQL) si env présent.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { PrismaAcquisitionOrchestratorLeaseRepository } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-lease.repository"
import { ACQUISITION_ORCHESTRATOR_LEASE_KEY } from "@/lib/acquisition/orchestrator/acquisition-orchestrator-feature-flag"

const TEST_URL = process.env.TEST_ACQUISITION_DATABASE_URL
const enabled = Boolean(TEST_URL)

const db = enabled
  ? new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  : (null as unknown as PrismaClient)

const RUN = { skip: enabled ? undefined : "TEST_ACQUISITION_DATABASE_URL non défini" }

describe("acquisition-orchestrator-lease PG", RUN, () => {
  const key = `${ACQUISITION_ORCHESTRATOR_LEASE_KEY}-test-${Date.now()}`
  const repo = enabled
    ? new PrismaAcquisitionOrchestratorLeaseRepository(db)
    : (null as unknown as PrismaAcquisitionOrchestratorLeaseRepository)

  before(async () => {
    await db.$executeRaw`
      INSERT INTO "acquisition_orchestrator_leases" ("key", "ownerRunId", "leaseExpiresAt", "acquiredAt", "updatedAt")
      VALUES (${key}, NULL, NULL, NULL, clock_timestamp())
      ON CONFLICT ("key") DO NOTHING
    `
  })

  after(async () => {
    await db.$executeRaw`DELETE FROM "acquisition_orchestrator_leases" WHERE "key" = ${key}`
    await db.$disconnect()
  })

  it("concurrence : un ACQUIRED, un ALREADY_RUNNING", async () => {
    const [a, b] = await Promise.all([
      repo.acquire({ key, ownerRunId: "pg-a", leaseTtlMs: 60_000 }),
      repo.acquire({ key, ownerRunId: "pg-b", leaseTtlMs: 60_000 }),
    ])
    const outcomes = [a.outcome, b.outcome].sort()
    assert.deepEqual(outcomes, ["ACQUIRED", "ALREADY_RUNNING"])
    const winner = a.outcome === "ACQUIRED" ? "pg-a" : "pg-b"
    const relWrong = await repo.release({ key, ownerRunId: "not-owner" })
    assert.equal(relWrong.outcome, "NOT_OWNER")
    const rel = await repo.release({ key, ownerRunId: winner })
    assert.equal(rel.outcome, "RELEASED")
  })
})
