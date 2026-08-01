/**
 * LOT-2A — normalize-subject Unicode-safe.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { normalizeSubject } from "@/lib/integration/normalizers/message/normalize-subject"
import { INBOUND_SOURCE_BOUNDS } from "@/lib/integration/types/inbound-source-rule-type"

describe("normalizeSubject", () => {
  it("trim + NFC", () => {
    assert.equal(normalizeSubject("  Hello  "), "Hello")
    // é en NFD → NFC
    const nfd = "e\u0301"
    assert.equal(normalizeSubject(`  ${nfd}  `), "é")
  })

  it("whitespace-only → undefined", () => {
    assert.equal(normalizeSubject("   "), undefined)
    assert.equal(normalizeSubject(""), undefined)
    assert.equal(normalizeSubject(null), undefined)
  })

  it("troncature Unicode-safe 512 points de code", () => {
    const emoji = "😀"
    const many = emoji.repeat(INBOUND_SOURCE_BOUNDS.SUBJECT_MAX + 10)
    const out = normalizeSubject(many)
    assert.ok(out)
    assert.equal(Array.from(out!).length, INBOUND_SOURCE_BOUNDS.SUBJECT_MAX)
  })
})
