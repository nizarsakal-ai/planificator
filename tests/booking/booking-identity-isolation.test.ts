/**
 * PLAN-BOOKING-FINAL-2 R3 — Isolation + bornes UTF-8 + contrats SQL.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  accommodationFieldsFromPendingIdentity,
  agentPendingIdempotencyKey,
  BOOKING_REFERENCE_MAX_BYTES,
  gmailPendingIdempotencyKey,
  IDEMPOTENCY_KEY_MAX_BYTES,
  isGmailAutoProcessSafe,
  n8nPendingIdempotencyKey,
  PENDING_SOURCE_KIND,
  resolveAgentPendingIdentity,
  utf8ByteLength,
} from "@/lib/booking/booking-pending-identity"
import { AgentSchema } from "@/lib/booking/booking-agent.handler"

const ROOT = process.cwd()
const MIGRATION_SQL = readFileSync(
  join(
    ROOT,
    "prisma/migrations/20260802120000_booking_identity_tenant_isolation/migration.sql"
  ),
  "utf8"
)

describe("booking-pending-identity helpers", () => {
  it("sépare gmail / n8n / agent", () => {
    assert.equal(gmailPendingIdempotencyKey("msg-1"), "gmail:msg-1")
    assert.equal(n8nPendingIdempotencyKey("BK-99"), "n8n:BK-99")
    assert.equal(agentPendingIdempotencyKey("BK-99"), "agent:BK-99")
  })

  it("UTF-8 : ASCII à la limite accepté ; multioctet rejeté", () => {
    const asciiRef = "R".repeat(BOOKING_REFERENCE_MAX_BYTES)
    assert.equal(utf8ByteLength(asciiRef), BOOKING_REFERENCE_MAX_BYTES)
    assert.equal(n8nPendingIdempotencyKey(asciiRef), `n8n:${asciiRef}`)

    // 43 × 'é' (2 octets) = 86 < 128 chars but wait we need exceed bytes with fewer chars
    // 65 × '€' (3 octets) = 195 > 128 bytes, char count 65 < 128
    const multi = "€".repeat(65)
    assert.ok(multi.length < BOOKING_REFERENCE_MAX_BYTES)
    assert.ok(utf8ByteLength(multi) > BOOKING_REFERENCE_MAX_BYTES)
    assert.throws(() => n8nPendingIdempotencyKey(multi))

    const maxRef = "a".repeat(BOOKING_REFERENCE_MAX_BYTES)
    const key = n8nPendingIdempotencyKey(maxRef)
    assert.ok(utf8ByteLength(key) <= IDEMPOTENCY_KEY_MAX_BYTES)
    assert.ok(key.startsWith("n8n:"))
  })

  it("Zod Agent : rejet multioctet sans écriture implicite", () => {
    const multi = "€".repeat(65)
    const parsed = AgentSchema.safeParse({
      companyId: "c",
      rawEmailText: "x",
      externalEventId: multi,
    })
    assert.equal(parsed.success, false)
  })

  it("Agent identité déterministe", () => {
    const a = resolveAgentPendingIdentity({ externalEventId: "evt-1" })
    const b = resolveAgentPendingIdentity({ externalEventId: "evt-1" })
    assert.equal(a.ok && b.ok, true)
    if (a.ok && b.ok) {
      assert.equal(a.idempotencyKey, b.idempotencyKey)
      assert.equal(a.externalSourceId, null)
    }
    assert.equal(resolveAgentPendingIdentity({}).ok, false)
  })

  it("confirmation mapping + garde autoProcess", () => {
    assert.equal(
      accommodationFieldsFromPendingIdentity({
        sourceKind: PENDING_SOURCE_KIND.N8N,
        gmailMessageId: null,
        externalSourceId: "BK",
        idempotencyKey: "n8n:BK",
      }).source,
      "n8n"
    )
    assert.equal(
      isGmailAutoProcessSafe({ sourceKind: "N8N", gmailMessageId: null }),
      false
    )
    assert.equal(
      isGmailAutoProcessSafe({ sourceKind: "GMAIL", gmailMessageId: "m" }),
      true
    )
  })
})

describe("migration BKG-FINAL-2 R3 SQL", () => {
  it("BEGIN puis COMMIT unique ; pas de COMMIT avant BEGIN ; Gmail prouvé", () => {
    const withoutComments = MIGRATION_SQL.replace(/--[^\n]*/g, "")
    assert.match(withoutComments, /^\s*BEGIN\s*;/m)
    assert.match(withoutComments, /^\s*COMMIT\s*;\s*$/m)
    const commits = withoutComments.match(/^\s*COMMIT\s*;/gm) ?? []
    const begins = withoutComments.match(/^\s*BEGIN\s*;/gm) ?? []
    assert.equal(begins.length, 1)
    assert.equal(commits.length, 1)
    const beginIdx = withoutComments.search(/^\s*BEGIN\s*;/m)
    const commitIdx = withoutComments.search(/^\s*COMMIT\s*;/m)
    assert.ok(beginIdx < commitIdx)
    assert.equal(/\bDELETE\b/i.test(withoutComments), false)

    assert.match(MIGRATION_SQL, /processed_gmail_messages/)
    assert.match(MIGRATION_SQL, /JAMAIS par défaut|jamais classé GMAIL|Aucune classification Gmail par défaut/i)
    assert.match(MIGRATION_SQL, /non classifiables/)
    assert.match(MIGRATION_SQL, /N8N\+Agent|N8N\+Gmail|Agent\+Gmail/)
    assert.match(MIGRATION_SQL, /octet_length/)
    // Plus de backfill Gmail sur reste non prouvé
    assert.equal(
      /WHERE "sourceKind" IS NULL\s+AND "gmailMessageId" IS NOT NULL;\s*$/m.test(
        MIGRATION_SQL
      ),
      false
    )
  })
})
