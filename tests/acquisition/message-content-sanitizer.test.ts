process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  htmlToPlainText,
  hashNormalizedText,
  sanitizeMessageBodyParts,
} from "@/lib/acquisition/content/message-content-sanitizer"
import { getContentNormalizedMaxBytes } from "@/lib/acquisition/content/content-fetch-feature-flag"

describe("message-content-sanitizer", () => {
  it("préfère text/plain à text/html", () => {
    const out = sanitizeMessageBodyParts({
      textPlain: "Bonjour plain",
      textHtml: "<p>Hello html</p>",
      mimeType: "multipart/alternative",
      charset: "utf-8",
      providerMessageId: "g1",
      byteLengthOriginal: 40,
    })
    assert.equal(out.normalizedText, "Bonjour plain")
    assert.equal(out.sourceMimeType, "text/plain")
    assert.equal(out.hadHtml, true)
    assert.equal(out.byteLengthNormalized, Buffer.byteLength("Bonjour plain", "utf8"))
  })

  it("fallback HTML → texte sans balises ni script", () => {
    const html = `<html><script>alert(1)</script><p>Devis <b>urgent</b></p><style>.x{}</style></html>`
    const text = htmlToPlainText(html)
    assert.ok(!text.includes("<"))
    assert.ok(!text.includes("alert"))
    assert.ok(text.includes("Devis"))
    assert.ok(text.includes("urgent"))
  })

  it("redacte secrets sans tronquer", () => {
    const out = sanitizeMessageBodyParts({
      textPlain: `token=supersecret123\nBearer eyJhbGciOiJIUzI1NiJ9.xx\nOK`,
      textHtml: null,
      mimeType: "text/plain",
      charset: null,
      providerMessageId: "g2",
      byteLengthOriginal: 200,
    })
    assert.ok(out.normalizedText.includes("[REDACTED]"))
    assert.ok(!out.normalizedText.includes("supersecret123"))
    assert.ok(!out.normalizedText.includes("eyJhbGci"))
    assert.ok(out.normalizedText.includes("OK"))
  })

  it("mesure UTF-8 multioctet correctement", () => {
    const text = "é".repeat(10) // 2 bytes each in UTF-8
    const out = sanitizeMessageBodyParts({
      textPlain: text,
      textHtml: null,
      mimeType: "text/plain",
      charset: "utf-8",
      providerMessageId: "g3",
      byteLengthOriginal: 20,
    })
    assert.equal(out.byteLengthNormalized, 20)
    assert.equal(out.normalizedText.length, 10)
    assert.ok(getContentNormalizedMaxBytes() >= 64 * 1024)
  })

  it("hash stable", () => {
    assert.equal(hashNormalizedText("abc"), hashNormalizedText("abc"))
    assert.notEqual(hashNormalizedText("abc"), hashNormalizedText("abd"))
  })
})
