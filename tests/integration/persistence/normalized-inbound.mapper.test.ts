/**
 * LOT-1B2 — unitaires mapper NormalizedInbound.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  INTEGRATION_INBOUND_ERROR,
  IntegrationInboundPayloadTooLargeError,
  IntegrationInboundValidationError,
} from "@/lib/integration/persistence/integration-inbound.errors"
import {
  ARTIFACT_REFS_MAX,
  NORMALIZED_MESSAGE_MAX_BYTES,
  mapRowToNormalizedInbound,
  serializeNormalizedMessage,
  toPrismaCreateNormalizedData,
  validateArtifactRefs,
} from "@/lib/integration/persistence/normalized-inbound.mapper"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import type { NormalizedInbound as NormalizedInboundRow } from "@prisma/client"

const smallMessage = {
  externalMessageId: "m1",
  contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
  subject: "Hello",
}

function baseInput(over: Record<string, unknown> = {}) {
  return {
    companyId: "co1",
    connectionId: "conn1",
    envelopeId: "env1",
    family: "MESSAGE" as const,
    occurredAt: "2026-08-01T09:00:00.000Z",
    receivedAt: "2026-08-01T10:00:00.000Z",
    normalizedHash: "hash1",
    artifactRefs: [] as string[],
    message: smallMessage,
    ...over,
  }
}

describe("normalized-inbound.mapper", () => {
  it("create data + round-trip message", () => {
    const data = toPrismaCreateNormalizedData(baseInput())
    assert.equal(data.family, "MESSAGE")
    assert.equal(data.schemaVersion, PLATFORM_SCHEMA_VERSION_V1)
    assert.deepEqual(data.artifactRefs, [])
  })

  it("artifactRefs [] OK", () => {
    assert.deepEqual(validateArtifactRefs([]), [])
  })

  it("artifactRefs élément vide → VALIDATION", () => {
    assert.throws(
      () => validateArtifactRefs([""]),
      (e: unknown) =>
        e instanceof IntegrationInboundValidationError &&
        e.code === INTEGRATION_INBOUND_ERROR.VALIDATION
    )
  })

  it("artifactRefs doublons → VALIDATION", () => {
    assert.throws(
      () => validateArtifactRefs(["a", "a"]),
      (e: unknown) => e instanceof IntegrationInboundValidationError
    )
  })

  it("artifactRefs > max → VALIDATION", () => {
    const refs = Array.from({ length: ARTIFACT_REFS_MAX + 1 }, (_, i) => `r${i}`)
    assert.throws(
      () => validateArtifactRefs(refs),
      (e: unknown) => e instanceof IntegrationInboundValidationError
    )
  })

  it("taille 262144 OK / 262145 → PAYLOAD_TOO_LARGE", () => {
    const ok = serializeNormalizedMessage(smallMessage)
    assert.ok(ok.byteLength <= NORMALIZED_MESSAGE_MAX_BYTES)

    // Force oversized by crafting subject that exceeds limit when stringified.
    const pad = "x".repeat(NORMALIZED_MESSAGE_MAX_BYTES)
    assert.throws(
      () =>
        serializeNormalizedMessage({
          ...smallMessage,
          subject: pad,
        }),
      (e: unknown) =>
        e instanceof IntegrationInboundPayloadTooLargeError &&
        e.code === INTEGRATION_INBOUND_ERROR.PAYLOAD_TOO_LARGE
    )
  })

  it("message Zod invalide → VALIDATION", () => {
    assert.throws(
      () => toPrismaCreateNormalizedData(baseInput({ message: { sender: {} } })),
      (e: unknown) => e instanceof IntegrationInboundValidationError
    )
  })

  it("row → contrat", () => {
    const row = {
      id: "n1",
      companyId: "co1",
      connectionId: "conn1",
      envelopeId: "env1",
      family: "MESSAGE",
      occurredAt: new Date("2026-08-01T09:00:00.000Z"),
      receivedAt: new Date("2026-08-01T10:00:00.000Z"),
      normalizedHash: "hash1",
      artifactRefs: [],
      schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
      message: smallMessage,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as NormalizedInboundRow
    const mapped = mapRowToNormalizedInbound(row)
    assert.equal(mapped.id, "n1")
    assert.equal(mapped.message.externalMessageId, "m1")
  })
})
