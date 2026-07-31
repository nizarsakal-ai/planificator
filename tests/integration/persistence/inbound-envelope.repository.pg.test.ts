/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1B2
 * Tests PostgreSQL — InboundEnvelope repository (idempotence, CAS, tenant).
 *
 * Base jetable uniquement via :
 *   TEST_INTEGRATION_DATABASE_URL  (prioritaire)
 *   ou TEST_ACQUISITION_DATABASE_URL (convention dépôt)
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after, afterEach } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import {
  INTEGRATION_INBOUND_ERROR,
  IntegrationInboundIdempotencyConflictError,
  IntegrationInboundLifecycleConflictError,
  IntegrationInboundNotFoundError,
  IntegrationInboundPersistenceError,
} from "@/lib/integration/persistence/integration-inbound.errors"
import { InboundEnvelopeRepository } from "@/lib/integration/persistence/inbound-envelope.repository"
import type { CreateInboundEnvelopeInput } from "@/lib/integration/persistence/inbound-envelope.mapper"
import { CONNECTION_STATUSES } from "@/lib/integration/types/connection-status"
import { SECRET_BACKENDS } from "@/lib/integration/types/secret-backend"
import { ENVELOPE_LIFECYCLE_STATUSES } from "@/lib/integration/types/envelope-lifecycle"
import {
  assertSafeDisposableTestDatabaseUrl,
  resolveIntegrationTestDatabaseUrl,
} from "./helpers/safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) {
  console.error(
    "Tests PG InboundEnvelope : fournir TEST_INTEGRATION_DATABASE_URL ou TEST_ACQUISITION_DATABASE_URL."
  )
  process.exit(1)
}
assertSafeDisposableTestDatabaseUrl(resolved.url)

const TEST_URL = resolved.url
const db = new PrismaClient({ datasources: { db: { url: TEST_URL } } })
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function envelopeInput(
  companyId: string,
  connectionId: string,
  overrides: Partial<CreateInboundEnvelopeInput> = {}
): CreateInboundEnvelopeInput {
  return {
    companyId,
    connectionId,
    externalId: `ext-${runId}`,
    idempotencyKey: `idem-${runId}`,
    receivedAt: "2026-08-01T10:00:00.000Z",
    payloadRef: `payload-${runId}`,
    contentType: "application/json",
    ...overrides,
  }
}

async function seedConnection(companyId: string, connectorType = "fixture.connector") {
  return db.integrationConnection.create({
    data: {
      companyId,
      connectorType,
      displayName: `EnvConn-${runId}`,
      status: CONNECTION_STATUSES.ACTIVE,
      secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED,
      config: {},
    },
  })
}

describe("LOT-1B2 InboundEnvelope — PostgreSQL", () => {
  let companyA = ""
  let companyB = ""
  let connA = ""
  let connB = ""
  let repo: InboundEnvelopeRepository

  before(async () => {
    const a = await db.company.create({
      data: { name: `Env A ${runId}`, slug: `env-a-${runId}` },
    })
    const b = await db.company.create({
      data: { name: `Env B ${runId}`, slug: `env-b-${runId}` },
    })
    companyA = a.id
    companyB = b.id
    const ca = await seedConnection(companyA)
    const cb = await seedConnection(companyB)
    connA = ca.id
    connB = cb.id
    repo = new InboundEnvelopeRepository(db)

    const tables = await db.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'integration_inbound_envelopes'
      ) AS exists
    `
    assert.equal(tables[0]?.exists, true, "migration LOT-1B2 envelopes absente")
  })

  afterEach(async () => {
    await db.normalizedInbound.deleteMany({
      where: { companyId: { in: [companyA, companyB].filter(Boolean) } },
    })
    await db.inboundEnvelope.deleteMany({
      where: { companyId: { in: [companyA, companyB].filter(Boolean) } },
    })
  })

  after(async () => {
    for (const companyId of [companyA, companyB]) {
      if (!companyId) continue
      await db.normalizedInbound.deleteMany({ where: { companyId } })
      await db.inboundEnvelope.deleteMany({ where: { companyId } })
      await db.integrationConnection.deleteMany({ where: { companyId } })
      await db.company.delete({ where: { id: companyId } }).catch(() => undefined)
    }
    await db.$disconnect()
  })

  it("migration : enums, uniques, FK composite Connection présents", async () => {
    const enums = await db.$queryRaw<Array<{ typname: string }>>`
      SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typname IN ('EnvelopeLifecycleStatus', 'InboundFamily')
      ORDER BY t.typname
    `
    assert.deepEqual(
      enums.map((e) => e.typname),
      ["EnvelopeLifecycleStatus", "InboundFamily"]
    )

    const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'integration_inbound_envelopes'
      ORDER BY indexname
    `
    const names = indexes.map((i) => i.indexname)
    assert.ok(names.includes("integration_inbound_envelopes_idempotency_key"))
    assert.ok(names.includes("integration_inbound_envelopes_id_companyId_key"))
    assert.ok(
      names.includes("integration_inbound_envelopes_id_companyId_connectionId_key")
    )

    const fks = await db.$queryRaw<Array<{ conname: string }>>`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE rel.relname = 'integration_inbound_envelopes'
        AND c.contype = 'f'
      ORDER BY c.conname
    `
    const fkNames = fks.map((f) => f.conname)
    assert.ok(fkNames.includes("integration_inbound_envelopes_companyId_fkey"))
    assert.ok(
      fkNames.includes("integration_inbound_envelopes_connectionId_companyId_fkey")
    )
  })

  it("crée une Envelope avec connectorType snapshot Connection (immutable)", async () => {
    const created = await repo.createIdempotent(envelopeInput(companyA, connA))
    assert.equal(created.companyId, companyA)
    assert.equal(created.connectionId, connA)
    assert.equal(created.connectorType, "fixture.connector")
    assert.equal(created.lifecycleStatus, ENVELOPE_LIFECYCLE_STATUSES.RECEIVED)
    assert.equal("rawPayloadHash" in created, false)
  })

  it("Company A + Company B, même idempotencyKey X → deux inserts réussissent", async () => {
    const sharedKey = `shared-idem-X-${runId}`
    const a = await repo.createIdempotent(
      envelopeInput(companyA, connA, {
        idempotencyKey: sharedKey,
        externalId: `ext-a-${runId}`,
      })
    )
    const b = await repo.createIdempotent(
      envelopeInput(companyB, connB, {
        idempotencyKey: sharedKey,
        externalId: `ext-b-${runId}`,
      })
    )
    assert.notEqual(a.id, b.id)
    assert.equal(a.idempotencyKey, sharedKey)
    assert.equal(b.idempotencyKey, sharedKey)
    assert.equal(a.companyId, companyA)
    assert.equal(b.companyId, companyB)
  })

  it("collision compatible → même Envelope (idempotence)", async () => {
    const input = envelopeInput(companyA, connA, {
      idempotencyKey: `compat-${runId}`,
    })
    const first = await repo.createIdempotent(input)
    const second = await repo.createIdempotent({
      ...input,
      receivedAt: "2099-01-01T00:00:00.000Z",
    })
    assert.equal(first.id, second.id)
    assert.equal(second.receivedAt, first.receivedAt)
  })

  it("collision incompatible → IDEMPOTENCY_CONFLICT", async () => {
    const key = `conflict-${runId}`
    await repo.createIdempotent(
      envelopeInput(companyA, connA, {
        idempotencyKey: key,
        externalId: "ext-original",
      })
    )
    await assert.rejects(
      () =>
        repo.createIdempotent(
          envelopeInput(companyA, connA, {
            idempotencyKey: key,
            externalId: "ext-different",
          })
        ),
      (err: unknown) =>
        err instanceof IntegrationInboundIdempotencyConflictError &&
        err.code === INTEGRATION_INBOUND_ERROR.IDEMPOTENCY_CONFLICT
    )
  })

  it("createIdempotent concurrent Promise.all → une seule ligne", async () => {
    const key = `concurrent-${runId}`
    const input = envelopeInput(companyA, connA, { idempotencyKey: key })
    const results = await Promise.all([
      repo.createIdempotent(input),
      repo.createIdempotent(input),
      repo.createIdempotent(input),
    ])
    const ids = new Set(results.map((r) => r.id))
    assert.equal(ids.size, 1)
    const count = await db.inboundEnvelope.count({
      where: { companyId: companyA, connectionId: connA, idempotencyKey: key },
    })
    assert.equal(count, 1)
  })

  it("connection absente / cross-tenant → NOT_FOUND", async () => {
    await assert.rejects(
      () =>
        repo.createIdempotent(
          envelopeInput(companyA, "missing-connection-id")
        ),
      (err: unknown) => err instanceof IntegrationInboundNotFoundError
    )

    const created = await repo.createIdempotent(envelopeInput(companyA, connA))
    await assert.rejects(
      () => repo.findById(companyB, created.id),
      (err: unknown) =>
        err instanceof IntegrationInboundNotFoundError &&
        err.code === INTEGRATION_INBOUND_ERROR.NOT_FOUND
    )
  })

  it("CAS lifecycle succès", async () => {
    const created = await repo.createIdempotent(envelopeInput(companyA, connA))
    const updated = await repo.transitionLifecycle({
      companyId: companyA,
      envelopeId: created.id,
      expectedStatuses: [ENVELOPE_LIFECYCLE_STATUSES.RECEIVED],
      targetStatus: ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED,
    })
    assert.equal(updated.lifecycleStatus, ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED)
  })

  it("concurrence CAS → un succès + un LIFECYCLE_CONFLICT", async () => {
    const created = await repo.createIdempotent(
      envelopeInput(companyA, connA, { idempotencyKey: `cas-race-${runId}` })
    )
    const results = await Promise.allSettled([
      repo.transitionLifecycle({
        companyId: companyA,
        envelopeId: created.id,
        expectedStatuses: [ENVELOPE_LIFECYCLE_STATUSES.RECEIVED],
        targetStatus: ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED,
      }),
      repo.transitionLifecycle({
        companyId: companyA,
        envelopeId: created.id,
        expectedStatuses: [ENVELOPE_LIFECYCLE_STATUSES.RECEIVED],
        targetStatus: ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED,
      }),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.ok(
      rejected[0]!.status === "rejected" &&
        rejected[0].reason instanceof IntegrationInboundLifecycleConflictError
    )
  })

  it("CAS statut hors expected → LIFECYCLE_CONFLICT", async () => {
    const created = await repo.createIdempotent(
      envelopeInput(companyA, connA, { idempotencyKey: `cas-miss-${runId}` })
    )
    await assert.rejects(
      () =>
        repo.transitionLifecycle({
          companyId: companyA,
          envelopeId: created.id,
          expectedStatuses: [ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED],
          targetStatus: ENVELOPE_LIFECYCLE_STATUSES.ROUTED,
        }),
      (err: unknown) => err instanceof IntegrationInboundLifecycleConflictError
    )
  })

  it("FK composite : companyId ≠ connection.companyId → PERSISTENCE", async () => {
    await assert.rejects(
      () =>
        repo.createIdempotent(
          envelopeInput(companyB, connA, {
            idempotencyKey: `fk-bad-${runId}`,
          })
        ),
      (err: unknown) => {
        // connection look-up by (connA, companyB) → NOT_FOUND avant insert
        return (
          err instanceof IntegrationInboundNotFoundError ||
          err instanceof IntegrationInboundPersistenceError
        )
      }
    )
  })

  it("CASCADE Connection → Envelope", async () => {
    const suffix = `${runId}-casc-env`
    const company = await db.company.create({
      data: { name: `CascEnv ${suffix}`, slug: `casc-env-${suffix}` },
    })
    const conn = await seedConnection(company.id)
    const localRepo = new InboundEnvelopeRepository(db)
    const env = await localRepo.createIdempotent(
      envelopeInput(company.id, conn.id, {
        idempotencyKey: `casc-${suffix}`,
      })
    )
    await db.integrationConnection.delete({ where: { id: conn.id } })
    const orphan = await db.inboundEnvelope.findUnique({ where: { id: env.id } })
    assert.equal(orphan, null)
    await db.company.delete({ where: { id: company.id } }).catch(() => undefined)
  })
})
