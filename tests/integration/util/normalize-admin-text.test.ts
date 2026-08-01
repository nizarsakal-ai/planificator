/**
 * LOT-2A — normalizeAdminText (Unicode).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  AdminTextNormalizationError,
  normalizeAdminText,
} from "@/lib/integration/util/normalize-admin-text"

describe("normalizeAdminText", () => {
  it("trim + NFC + refuse whitespace-only", () => {
    assert.equal(normalizeAdminText("  Hello  ", 200, "displayName"), "Hello")
    assert.throws(
      () => normalizeAdminText("   ", 200, "displayName"),
      AdminTextNormalizationError
    )
  })

  it("NFD et NFC : même longueur logique après NFC", () => {
    const nfd = "e\u0301" // é décomposé
    const nfc = "é"
    assert.equal(normalizeAdminText(nfd, 10, "displayName"), nfc)
    assert.equal(
      Array.from(normalizeAdminText(nfd, 10, "displayName")).length,
      1
    )
  })

  it("surrogate pairs (emoji) comptés en points de code", () => {
    const emoji = "😀"
    assert.equal(normalizeAdminText(emoji.repeat(3), 3, "displayName"), "😀😀😀")
    assert.throws(
      () => normalizeAdminText(emoji.repeat(4), 3, "displayName"),
      AdminTextNormalizationError
    )
  })
})
