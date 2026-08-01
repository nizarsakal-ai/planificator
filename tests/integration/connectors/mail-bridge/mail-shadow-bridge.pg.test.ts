/**
 * LOT-1C — PostgreSQL Mail Shadow Bridge.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it, before, after, afterEach } from "node:test"
import assert from "node:assert/strict"
import { PrismaClient } from "@prisma/client"
import { MailShadowBridgeService } from "@/lib/integration/connectors/mail-bridge/mail-shadow-bridge.service"
import { createMailShadowRunStats } from "@/lib/integration/connectors/mail-bridge/mail-shadow-run-stats"
import { MAIL_SHADOW_CONNECTOR_TYPE } from "@/lib/integration/flags/platform-flag-names"
import { CONNECTION_STATUSES } from "@/lib/integration/types/connection-status"
import { SECRET_BACKENDS } from "@/lib/integration/types/secret-backend"
import { ENVELOPE_LIFECYCLE_STATUSES } from "@/lib/integration/types/envelope-lifecycle"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"
import { INBOUND_FAMILY } from "@/lib/integration/types/inbound-family"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import {
  assertSafeDisposableTestDatabaseUrl,
  resolveIntegrationTestDatabaseUrl,
} from "../../persistence/helpers/safe-test-database-url"

const resolved = resolveIntegrationTestDatabaseUrl()
if (!resolved.ok) {
  console.error("Tests PG LOT-1C : TEST_INTEGRATION_DATABASE_URL requis")
  process.exit(1)
}
assertSafeDisposableTestDatabaseUrl(resolved.url)

const db = new PrismaClient({ datasources: { db: { url: resolved.url } } })
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

function dto(companyId: string, connectionId: string, key: string, over: Record<string, unknown> = {}) {
  return {
    companyId,
    connectionId,
    externalId: key,
    idempotencyKey: key,
    receivedAt: "2026-08-01T10:00:00.000Z",
    occurredAt: "2026-08-01T09:00:00.000Z",
    payloadRef: `mail:${key}`,
    contentType: "message/rfc822",
    message: {
      externalMessageId: key,
      contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
    },
    ...over,
  }
}

describe("LOT-1C Mail Shadow — PostgreSQL", () => {
  let companyA = ""
  let companyB = ""
  let connA = ""
  let bridge: MailShadowBridgeService

  before(async () => {
    const a = await db.company.create({
      data: { name: `Shadow A ${runId}`, slug: `shadow-a-${runId}` },
    })
    const b = await db.company.create({
      data: { name: `Shadow B ${runId}`, slug: `shadow-b-${runId}` },
    })
    companyA = a.id
    companyB = b.id
    const ca = await db.integrationConnection.create({
      data: {
        companyId: companyA,
        connectorType: MAIL_SHADOW_CONNECTOR_TYPE,
        displayName: "Mail A",
        status: CONNECTION_STATUSES.ACTIVE,
        secretBackend: SECRET_BACKENDS.LEGACY_GMAIL,
        config: {},
      },
    })
    connA = ca.id
    await db.integrationConnection.create({
      data: {
        companyId: companyB,
        connectorType: MAIL_SHADOW_CONNECTOR_TYPE,
        displayName: "Mail B",
        status: CONNECTION_STATUSES.ACTIVE,
        secretBackend: SECRET_BACKENDS.LEGACY_GMAIL,
        config: {},
      },
    })
    bridge = new MailShadowBridgeService(db)
  })

  afterEach(async () => {
    await db.normalizedInbound.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
    await db.inboundEnvelope.deleteMany({
      where: { companyId: { in: [companyA, companyB] } },
    })
  })

  after(async () => {
    for (const companyId of [companyA, companyB]) {
      await db.normalizedInbound.deleteMany({ where: { companyId } })
      await db.inboundEnvelope.deleteMany({ where: { companyId } })
      await db.integrationConnection.deleteMany({ where: { companyId } })
      await db.company.delete({ where: { id: companyId } }).catch(() => undefined)
    }
    await db.$disconnect()
  })

  it("happy path → NORMALIZED + Normalized V1", async () => {
    const stats = createMailShadowRunStats()
    await bridge.project(dto(companyA, connA, `ok-${runId}`), { stats })
    const env = await db.inboundEnvelope.findFirst({
      where: { companyId: companyA, idempotencyKey: `ok-${runId}` },
    })
    assert.ok(env)
    assert.equal(env!.lifecycleStatus, ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED)
    const norm = await db.normalizedInbound.findFirst({
      where: { companyId: companyA, envelopeId: env!.id },
    })
    assert.ok(norm)
    assert.equal(norm!.family, INBOUND_FAMILY.MESSAGE)
    assert.ok(stats.normalized >= 1)
  })

  it("duplicate → une seule Envelope / Normalized", async () => {
    const key = `dup-${runId}`
    const stats1 = createMailShadowRunStats()
    const stats2 = createMailShadowRunStats()
    await bridge.project(dto(companyA, connA, key), { stats: stats1 })
    await bridge.project(dto(companyA, connA, key), { stats: stats2 })
    assert.equal(
      await db.inboundEnvelope.count({
        where: { companyId: companyA, idempotencyKey: key },
      }),
      1
    )
    assert.equal(stats2.duplicate, 1)
  })

  it("concurrence Promise.all → pas de NORMALIZE_FAILED si succès", async () => {
    const key = `race-${runId}`
    const results = await Promise.all(
      [1, 2, 3].map(async () => {
        const stats = createMailShadowRunStats()
        await bridge.project(dto(companyA, connA, key), { stats })
        return stats
      })
    )
    const env = await db.inboundEnvelope.findFirst({
      where: { companyId: companyA, idempotencyKey: key },
    })
    assert.ok(env)
    assert.equal(env!.lifecycleStatus, ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED)
    assert.equal(
      await db.normalizedInbound.count({
        where: { companyId: companyA, envelopeId: env!.id },
      }),
      1
    )
    assert.equal(
      results.reduce((n, s) => n + s.normalizeFailed, 0),
      0
    )
  })

  it("mauvaise connectionId → aucune Envelope", async () => {
    const stats = createMailShadowRunStats()
    await bridge.project(
      dto(companyA, "missing-conn", `bad-${runId}`),
      { stats }
    )
    assert.equal(
      await db.inboundEnvelope.count({
        where: { companyId: companyA, idempotencyKey: `bad-${runId}` },
      }),
      0
    )
  })

  it("isolation multi-tenant même idempotencyKey", async () => {
    const key = `tenant-${runId}`
    const connB = await db.integrationConnection.findFirst({
      where: { companyId: companyB },
    })
    assert.ok(connB)
    await bridge.project(dto(companyA, connA, key), {
      stats: createMailShadowRunStats(),
    })
    await bridge.project(dto(companyB, connB!.id, key), {
      stats: createMailShadowRunStats(),
    })
    assert.equal(
      await db.inboundEnvelope.count({ where: { idempotencyKey: key } }),
      2
    )
  })

  it("normalisation échouée isolée → NORMALIZE_FAILED (taille message)", async () => {
    const stats = createMailShadowRunStats()
    // DTO Zod OK ; mapper LOT-1B2 refuse > 256 KiB → create échoue → CAS FAILED.
    // LOT-2A tronque subject à 512 pts de code : surdimensionner via recipients.
    const recipients = Array.from({ length: 8000 }, (_, i) => ({
      email: `user${i}@example-very-long-domain-name-for-payload-size.com`,
    }))
    await bridge.project(
      dto(companyA, connA, `fail-${runId}`, {
        message: {
          externalMessageId: `fail-${runId}`,
          contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
          recipients,
        },
      }),
      { stats }
    )
    const env = await db.inboundEnvelope.findFirst({
      where: { companyId: companyA, idempotencyKey: `fail-${runId}` },
    })
    assert.ok(env)
    assert.equal(
      env!.lifecycleStatus,
      ENVELOPE_LIFECYCLE_STATUSES.NORMALIZE_FAILED
    )
    assert.equal(
      await db.normalizedInbound.count({ where: { envelopeId: env!.id } }),
      0
    )
    assert.equal(stats.normalizeFailed, 1)
  })

  it("version conflict concurrent → NORMALIZED, jamais FAILED si succès", async () => {
    const key = `vconf-${runId}`
    const env = await db.inboundEnvelope.create({
      data: {
        companyId: companyA,
        connectionId: connA,
        connectorType: MAIL_SHADOW_CONNECTOR_TYPE,
        externalId: key,
        idempotencyKey: key,
        receivedAt: new Date("2026-08-01T10:00:00.000Z"),
        payloadRef: `mail:${key}`,
        contentType: "message/rfc822",
        schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
        lifecycleStatus: ENVELOPE_LIFECYCLE_STATUSES.RECEIVED,
      },
    })
    const results = await Promise.all(
      [1, 2, 3, 4].map(async () => {
        const stats = createMailShadowRunStats()
        await bridge.project(dto(companyA, connA, key), { stats })
        return stats
      })
    )
    const updated = await db.inboundEnvelope.findUnique({ where: { id: env.id } })
    assert.equal(
      updated!.lifecycleStatus,
      ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED
    )
    assert.equal(
      await db.normalizedInbound.count({
        where: { companyId: companyA, envelopeId: env.id },
      }),
      1
    )
    assert.equal(
      results.reduce((n, s) => n + s.normalizeFailed, 0),
      0
    )
  })

  it("RECEIVED avec Normalized existant → CAS NORMALIZED", async () => {
    const key = `repair-${runId}`
    const env = await db.inboundEnvelope.create({
      data: {
        companyId: companyA,
        connectionId: connA,
        connectorType: MAIL_SHADOW_CONNECTOR_TYPE,
        externalId: key,
        idempotencyKey: key,
        receivedAt: new Date("2026-08-01T10:00:00.000Z"),
        payloadRef: `mail:${key}`,
        contentType: "message/rfc822",
        schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
        lifecycleStatus: ENVELOPE_LIFECYCLE_STATUSES.RECEIVED,
      },
    })
    await db.normalizedInbound.create({
      data: {
        companyId: companyA,
        connectionId: connA,
        envelopeId: env.id,
        family: INBOUND_FAMILY.MESSAGE,
        occurredAt: new Date("2026-08-01T09:00:00.000Z"),
        receivedAt: new Date("2026-08-01T10:00:00.000Z"),
        normalizedHash: "preexisting",
        artifactRefs: [],
        schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
        message: {
          externalMessageId: key,
          contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
        },
      },
    })
    const stats = createMailShadowRunStats()
    await bridge.project(dto(companyA, connA, key), { stats })
    const updated = await db.inboundEnvelope.findUnique({ where: { id: env.id } })
    assert.equal(
      updated!.lifecycleStatus,
      ENVELOPE_LIFECYCLE_STATUSES.NORMALIZED
    )
    assert.ok(stats.normalized >= 1)
  })
})
