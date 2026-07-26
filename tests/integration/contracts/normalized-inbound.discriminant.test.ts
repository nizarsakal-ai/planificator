/**
 * LOT-1A STEP-5 — discriminant NormalizedInbound MESSAGE-only.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { normalizedInboundSchema } from "@/lib/integration/contracts/normalized-inbound"
import { INBOUND_FAMILY } from "@/lib/integration/types/inbound-family"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"

const UTC = "2026-07-26T10:00:00.000Z"

const validRoot = {
  id: "ni-1",
  companyId: "co-1",
  connectionId: "conn-1",
  envelopeId: "env-1",
  family: INBOUND_FAMILY.MESSAGE,
  occurredAt: UTC,
  receivedAt: UTC,
  normalizedHash: "hash-1",
  artifactRefs: ["art-1"],
  schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
  message: {
    externalMessageId: "ext-1",
    contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
  },
}

describe("NormalizedInbound discriminant V1", () => {
  it("accepte family MESSAGE avec payload message", () => {
    const parsed = normalizedInboundSchema.parse(validRoot)
    assert.equal(parsed.family, "MESSAGE")
    assert.equal(parsed.schemaVersion, "1.0.0")
    assert.ok(parsed.message)
    assert.equal("companyId" in parsed.message, false)
    assert.equal("connectorType" in parsed, false)
  })

  it("rejette DOCUMENT, EVENT et family arbitraire", () => {
    assert.equal(
      normalizedInboundSchema.safeParse({
        ...validRoot,
        family: "DOCUMENT",
      }).success,
      false
    )
    assert.equal(
      normalizedInboundSchema.safeParse({
        ...validRoot,
        family: "EVENT",
      }).success,
      false
    )
    assert.equal(
      normalizedInboundSchema.safeParse({
        ...validRoot,
        family: "OTHER",
      }).success,
      false
    )
  })

  it("rejette connectorType au root et provider dans message", () => {
    assert.equal(
      normalizedInboundSchema.safeParse({
        ...validRoot,
        connectorType: "anything",
      }).success,
      false
    )
    assert.equal(
      normalizedInboundSchema.safeParse({
        ...validRoot,
        message: {
          ...validRoot.message,
          gmailMessageId: "g-1",
        },
      }).success,
      false
    )
  })

  it("rejette schemaVersion arbitraire", () => {
    assert.equal(
      normalizedInboundSchema.safeParse({
        ...validRoot,
        schemaVersion: "9.9.9",
      }).success,
      false
    )
  })
})
