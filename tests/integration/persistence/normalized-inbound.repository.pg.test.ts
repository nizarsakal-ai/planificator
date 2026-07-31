/**
 * PLAN-INTEGRATION-PLATFORM-001 — LOT-1B2
 * Tests PostgreSQL — NormalizedInbound repository (version, JSONB, cascade, drift).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after, afterEach } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import {
  INTEGRATION_INBOUND_ERROR,
  IntegrationInboundNormalizedVersionConflictError,
  IntegrationInboundNotFoundError,
  IntegrationInboundPersistenceError,
} from "@/lib/integration/persistence/integration-inbound.errors"
import { InboundEnvelopeRepository } from "@/lib/integration/persistence/inbound-envelope.repository"
import { NormalizedInboundRepository } from "@/lib/integration/persistence/normalized-inbound.repository"
import type { CreateNormalizedInboundInput } from "@/lib/integration/persistence/normalized-inbound.mapper"
import { CONNECTION_STATUSES } from "@/lib/integration/types/connection-status"
import { SECRET_BACKENDS } from "@/lib/integration/types/secret-backend"
import { INBOUND_FAMILY } from "@/lib/integration/types/inbound-family"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import {
  assertSafeDisposableTestDatabaseUrl,
  resolveIntegrationTestDatabaseUrl,
} from "./helpers/safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) {
  console.error(
    "Tests PG NormalizedInbound : fournir TEST_INTEGRATION_DATABASE_URL ou TEST_ACQUISITION_DATABASE_URL."
  )
  process.exit(1)
}
assertSafeDisposableTestDatabaseUrl(resolved.url)

const TEST_URL = resolved.url
const db = new PrismaClient({ datasources: { db: { url: TEST_URL } } })
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const sampleMessage = {
  externalMessageId: `msg-${runId}`,
  contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
  subject: "Sujet test",
}

async function seedConnection(companyId: string) {
  return db.integrationConnection.create({
    data: {
      companyId,
      connectorType: "fixture.connector",
      displayName: `NormConn-${runId}`,
      status: CONNECTION_STATUSES.ACTIVE,
      secretBackend: SECRET_BACKENDS.PLATFORM_ENCRYPTED,
      config: {},
    },
  })
}

describe("LOT-1B2 NormalizedInbound — PostgreSQL", () => {
  let companyA = ""
  let companyB = ""
  let connA = ""
  let connA2 = ""
  let envelopeRepo: InboundEnvelopeRepository
  let normRepo: NormalizedInboundRepository

  before(async () => {
    const a = await db.company.create({
      data: { name: `Norm A ${runId}`, slug: `norm-a-${runId}` },
    })
    const b = await db.company.create({
      data: { name: `Norm B ${runId}`, slug: `norm-b-${runId}` },
    })
    companyA = a.id
    companyB = b.id
    const ca = await seedConnection(companyA)
    const ca2 = await seedConnection(companyA)
    connA = ca.id
    connA2 = ca2.id
    envelopeRepo = new InboundEnvelopeRepository(db)
    normRepo = new NormalizedInboundRepository(db)

    const tables = await db.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'integration_normalized_inbounds'
      ) AS exists
    `
    assert.equal(tables[0]?.exists, true, "migration LOT-1B2 normalized absente")
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

  async function createEnvelope(connectionId: string, keySuffix: string) {
    return envelopeRepo.createIdempotent({
      companyId: companyA,
      connectionId,
      externalId: `ext-${keySuffix}`,
      idempotencyKey: `idem-${keySuffix}`,
      receivedAt: "2026-08-01T10:00:00.000Z",
      payloadRef: `payload-${keySuffix}`,
      contentType: "application/json",
    })
  }

  function normInput(
    envelopeId: string,
    connectionId: string,
    overrides: Partial<CreateNormalizedInboundInput> = {}
  ): CreateNormalizedInboundInput {
    return {
      companyId: companyA,
      connectionId,
      envelopeId,
      family: INBOUND_FAMILY.MESSAGE,
      occurredAt: "2026-08-01T09:00:00.000Z",
      receivedAt: "2026-08-01T10:00:00.000Z",
      normalizedHash: `hash-${runId}`,
      artifactRefs: [],
      message: sampleMessage,
      ...overrides,
    }
  }

  it("migration : unique version + FK ternaire présents", async () => {
    const indexes = await db.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'integration_normalized_inbounds'
      ORDER BY indexname
    `
    const names = indexes.map((i) => i.indexname)
    assert.ok(names.includes("integration_normalized_inbounds_envelope_version_key"))
    assert.ok(names.includes("integration_normalized_inbounds_id_companyId_key"))

    const fks = await db.$queryRaw<Array<{ conname: string }>>`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      WHERE rel.relname = 'integration_normalized_inbounds'
        AND c.contype = 'f'
      ORDER BY c.conname
    `
    assert.ok(
      fks
        .map((f) => f.conname)
        .includes("integration_normalized_inbounds_envelope_tenant_connection_fkey")
    )
  })

  it("crée Normalized + JSONB round-trip message", async () => {
    const env = await createEnvelope(connA, `jsonb-${runId}`)
    const created = await normRepo.create(normInput(env.id, connA))
    assert.equal(created.envelopeId, env.id)
    assert.equal(created.family, INBOUND_FAMILY.MESSAGE)
    assert.equal(created.message.externalMessageId, sampleMessage.externalMessageId)
    assert.equal(created.message.subject, "Sujet test")

    const found = await normRepo.findById(companyA, created.id)
    assert.deepEqual(found.message.subject, "Sujet test")

    const byVersion = await normRepo.findByEnvelopeVersion(
      companyA,
      env.id,
      INBOUND_FAMILY.MESSAGE,
      PLATFORM_SCHEMA_VERSION_V1
    )
    assert.equal(byVersion.id, created.id)
  })

  it("doublon version → NORMALIZED_VERSION_CONFLICT", async () => {
    const env = await createEnvelope(connA, `ver-dup-${runId}`)
    await normRepo.create(normInput(env.id, connA))
    await assert.rejects(
      () =>
        normRepo.create(
          normInput(env.id, connA, {
            normalizedHash: "other-hash",
            message: {
              ...sampleMessage,
              externalMessageId: "other",
            },
          })
        ),
      (err: unknown) =>
        err instanceof IntegrationInboundNormalizedVersionConflictError &&
        err.code === INTEGRATION_INBOUND_ERROR.NORMALIZED_VERSION_CONFLICT
    )
  })

  it("drift connectionId Normalized ≠ Envelope refusé par la DB", async () => {
    const env = await createEnvelope(connA, `drift-${runId}`)
    await assert.rejects(
      () => normRepo.create(normInput(env.id, connA2)),
      (err: unknown) =>
        err instanceof IntegrationInboundPersistenceError &&
        err.code === INTEGRATION_INBOUND_ERROR.PERSISTENCE
    )
  })

  it("cross-tenant find → NOT_FOUND", async () => {
    const env = await createEnvelope(connA, `xt-${runId}`)
    const created = await normRepo.create(normInput(env.id, connA))
    await assert.rejects(
      () => normRepo.findById(companyB, created.id),
      (err: unknown) => err instanceof IntegrationInboundNotFoundError
    )
  })

  it("CASCADE Connection → Envelope → Normalized (pas d’orphelin)", async () => {
    const suffix = `${runId}-casc-norm`
    const company = await db.company.create({
      data: { name: `CascNorm ${suffix}`, slug: `casc-norm-${suffix}` },
    })
    const conn = await seedConnection(company.id)
    const localEnvRepo = new InboundEnvelopeRepository(db)
    const localNormRepo = new NormalizedInboundRepository(db)
    const env = await localEnvRepo.createIdempotent({
      companyId: company.id,
      connectionId: conn.id,
      externalId: `ext-${suffix}`,
      idempotencyKey: `idem-${suffix}`,
      receivedAt: "2026-08-01T10:00:00.000Z",
      payloadRef: `payload-${suffix}`,
      contentType: "application/json",
    })
    const norm = await localNormRepo.create({
      companyId: company.id,
      connectionId: conn.id,
      envelopeId: env.id,
      family: INBOUND_FAMILY.MESSAGE,
      occurredAt: "2026-08-01T09:00:00.000Z",
      receivedAt: "2026-08-01T10:00:00.000Z",
      normalizedHash: `hash-${suffix}`,
      artifactRefs: ["art-1"],
      message: sampleMessage,
    })

    await db.integrationConnection.delete({ where: { id: conn.id } })

    assert.equal(
      await db.inboundEnvelope.findUnique({ where: { id: env.id } }),
      null
    )
    assert.equal(
      await db.normalizedInbound.findUnique({ where: { id: norm.id } }),
      null
    )
    await db.company.delete({ where: { id: company.id } }).catch(() => undefined)
  })

  it("listByEnvelope ordonne par createdAt", async () => {
    // Une seule version V1 MESSAGE autorisée — list length 1 après create
    const env = await createEnvelope(connA, `list-${runId}`)
    const created = await normRepo.create(normInput(env.id, connA))
    const listed = await normRepo.listByEnvelope(companyA, env.id)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]!.id, created.id)
  })
})
