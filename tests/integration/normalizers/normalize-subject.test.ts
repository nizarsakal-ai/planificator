/**
 * LOT-2A — normalize-subject Unicode-safe (repris de la PR #42).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SUBJECT_MAX_CODEPOINTS, normalizeSubject } from "@/lib/integration/normalizers/message/normalize-subject"

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
    const many = emoji.repeat(SUBJECT_MAX_CODEPOINTS + 10)
    const out = normalizeSubject(many)
    assert.ok(out)
    assert.equal(Array.from(out!).length, SUBJECT_MAX_CODEPOINTS)
  })

  it("caractères de contrôle remplacés, aucun décodage HTML, type inattendu refusé", () => {
    assert.equal(normalizeSubject("Devis\u0000\nchantier\t42"), "Devis  chantier 42")
    assert.equal(normalizeSubject("Re: <b>urgent</b> &amp; devis"), "Re: <b>urgent</b> &amp; devis")
    assert.equal(normalizeSubject(42 as unknown as string), undefined)
    assert.equal(normalizeSubject("\u0007\u0007"), undefined)
  })
})
