/**
 * LOT-1B2 — unitaires mapper InboundEnvelope.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  INTEGRATION_INBOUND_ERROR,
  IntegrationInboundValidationError,
} from "@/lib/integration/persistence/integration-inbound.errors"
import {
  areEnvelopeImmutablesCompatible,
  mapRowToInboundEnvelope,
  parseCreateInboundEnvelopeInput,
  parseExpectedLifecycleStatuses,
  toPrismaCreateEnvelopeData,
  type PrismaCreateInboundEnvelopeData,
} from "@/lib/integration/persistence/inbound-envelope.mapper"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import { ENVELOPE_LIFECYCLE_STATUSES } from "@/lib/integration/types/envelope-lifecycle"
import type { InboundEnvelope as InboundEnvelopeRow } from "@prisma/client"

function baseInput(over: Record<string, unknown> = {}) {
  return {
    companyId: "co1",
    connectionId: "conn1",
    externalId: "ext-1",
    idempotencyKey: "idem-1",
    receivedAt: "2026-08-01T10:00:00.000Z",
    payloadRef: "payload-ref-1",
    contentType: "application/json",
    ...over,
  }
}

function fakeRow(
  over: Partial<InboundEnvelopeRow> = {}
): InboundEnvelopeRow {
  return {
    id: "env1",
    companyId: "co1",
    connectionId: "conn1",
    connectorType: "fixture.connector",
    externalId: "ext-1",
    idempotencyKey: "idem-1",
    receivedAt: new Date("2026-08-01T10:00:00.000Z"),
    payloadRef: "payload-ref-1",
    contentType: "application/json",
    schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
    lifecycleStatus: "RECEIVED",
    rawPayloadHash: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    ...over,
  }
}

describe("inbound-envelope.mapper", () => {
  it("parse + snapshot connectorType → create data", () => {
    const parsed = parseCreateInboundEnvelopeInput(baseInput())
    const data = toPrismaCreateEnvelopeData(parsed, "fixture.connector")
    assert.equal(data.connectorType, "fixture.connector")
    assert.equal(data.lifecycleStatus, "RECEIVED")
    assert.equal(data.schemaVersion, PLATFORM_SCHEMA_VERSION_V1)
  })

  it("connectorType mismatch → VALIDATION", () => {
    const parsed = parseCreateInboundEnvelopeInput(
      baseInput({ connectorType: "other" })
    )
    assert.throws(
      () => toPrismaCreateEnvelopeData(parsed, "fixture.connector"),
      (e: unknown) =>
        e instanceof IntegrationInboundValidationError &&
        e.code === INTEGRATION_INBOUND_ERROR.VALIDATION
    )
  })

  it("round-trip row → contrat (rawPayloadHash absent)", () => {
    const env = mapRowToInboundEnvelope(fakeRow())
    assert.equal(env.id, "env1")
    assert.equal(env.receivedAt, "2026-08-01T10:00:00.000Z")
    assert.equal("rawPayloadHash" in env, false)
  })

  it("rawPayloadHash présent round-trip", () => {
    const env = mapRowToInboundEnvelope(fakeRow({ rawPayloadHash: "abc" }))
    assert.equal(env.rawPayloadHash, "abc")
  })

  it("immutables compatibles ignorer receivedAt", () => {
    const candidate: PrismaCreateInboundEnvelopeData = {
      companyId: "co1",
      connectionId: "conn1",
      connectorType: "fixture.connector",
      externalId: "ext-1",
      idempotencyKey: "idem-1",
      receivedAt: new Date("2099-01-01T00:00:00.000Z"),
      payloadRef: "payload-ref-1",
      contentType: "application/json",
      schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
      rawPayloadHash: null,
      lifecycleStatus: "RECEIVED",
    }
    assert.equal(
      areEnvelopeImmutablesCompatible(fakeRow(), candidate),
      true
    )
  })

  it("immutables incompatibles (externalId)", () => {
    const candidate: PrismaCreateInboundEnvelopeData = {
      companyId: "co1",
      connectionId: "conn1",
      connectorType: "fixture.connector",
      externalId: "OTHER",
      idempotencyKey: "idem-1",
      receivedAt: new Date("2026-08-01T10:00:00.000Z"),
      payloadRef: "payload-ref-1",
      contentType: "application/json",
      schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
      rawPayloadHash: null,
      lifecycleStatus: "RECEIVED",
    }
    assert.equal(
      areEnvelopeImmutablesCompatible(fakeRow(), candidate),
      false
    )
  })

  it("expectedStatuses vide → VALIDATION", () => {
    assert.throws(
      () => parseExpectedLifecycleStatuses([]),
      (e: unknown) =>
        e instanceof IntegrationInboundValidationError &&
        e.code === INTEGRATION_INBOUND_ERROR.VALIDATION
    )
  })

  it("expectedStatuses valides", () => {
    const s = parseExpectedLifecycleStatuses([
      ENVELOPE_LIFECYCLE_STATUSES.RECEIVED,
    ])
    assert.deepEqual(s, ["RECEIVED"])
  })
})
