/**
 * LOT-2A — contrats InboundSource / InboundSourceRule.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { inboundSourceSchema } from "@/lib/integration/contracts/inbound-source"
import { inboundSourceRuleSchema } from "@/lib/integration/contracts/inbound-source-rule"
import {
  INBOUND_SOURCE_BOUNDS,
  INBOUND_SOURCE_RULE_TYPES,
  IDENTITY_RULE_TYPES,
  isIdentityRuleType,
} from "@/lib/integration/types/inbound-source-rule-type"
import { PLATFORM_SCHEMA_VERSION_V1 } from "@/lib/integration/types/schema-version"

describe("LOT-2A contracts — InboundSource / Rule", () => {
  it("accepte une Source valide sans connectionId", () => {
    const parsed = inboundSourceSchema.parse({
      id: "s1",
      companyId: "c1",
      displayName: "Partenaires",
      enabled: false,
      schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
    })
    assert.equal(parsed.enabled, false)
    assert.equal("connectionId" in parsed, false)
  })

  it("refuse connectionId (strict)", () => {
    assert.throws(() =>
      inboundSourceSchema.parse({
        id: "s1",
        companyId: "c1",
        displayName: "X",
        enabled: false,
        connectionId: "conn",
        schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
      })
    )
  })

  it("enum rule types fermé + identité", () => {
    assert.deepEqual(Object.values(INBOUND_SOURCE_RULE_TYPES).sort(), [
      "BODY_KEYWORD",
      "RECIPIENT_EMAIL",
      "SENDER_DOMAIN",
      "SENDER_EMAIL",
      "SUBJECT_KEYWORD",
    ])
    assert.equal(IDENTITY_RULE_TYPES.length, 2)
    assert.equal(isIdentityRuleType("SENDER_EMAIL"), true)
    assert.equal(isIdentityRuleType("SUBJECT_KEYWORD"), false)
  })

  it("accepte Rule + refuse displayName trop long / whitespace-only", () => {
    inboundSourceRuleSchema.parse({
      id: "r1",
      companyId: "c1",
      sourceId: "s1",
      type: "SENDER_EMAIL",
      value: "a@b.co",
      normalizedValue: "a@b.co",
      enabled: true,
      schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
    })
    const tooLong = "x".repeat(INBOUND_SOURCE_BOUNDS.DISPLAY_NAME_MAX + 1)
    assert.throws(() =>
      inboundSourceSchema.parse({
        id: "s1",
        companyId: "c1",
        displayName: tooLong,
        enabled: false,
        schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
      })
    )
    assert.throws(() =>
      inboundSourceSchema.parse({
        id: "s1",
        companyId: "c1",
        displayName: "   ",
        enabled: false,
        schemaVersion: PLATFORM_SCHEMA_VERSION_V1,
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
      })
    )
  })
})
