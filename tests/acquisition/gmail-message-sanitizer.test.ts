import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  sanitizePayloadForMetadata,
  extractAllowedHeaders,
  buildAllowedProviderMetadata,
} from "@/lib/acquisition/connector/gmail-message-sanitizer"

describe("gmail-message-sanitizer", () => {
  it("sanitizePayloadForMetadata supprime body.data", () => {
    const sanitized = sanitizePayloadForMetadata({
      mimeType: "multipart/mixed",
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          body: { size: 100, data: "c2VjcmV0IGJvZHk=" },
        },
        {
          partId: "1",
          filename: "doc.pdf",
          body: { attachmentId: "A1", size: 200 },
        },
      ],
    })

    const serialized = JSON.stringify(sanitized)
    assert.ok(!serialized.includes("data"))
    assert.ok(sanitized?.parts?.[1]?.body?.attachmentId === "A1")
  })

  it("extractAllowedHeaders — whitelist stricte", () => {
    const headers = extractAllowedHeaders([
      { name: "From", value: "a@lauralu.fr" },
      { name: "Authorization", value: "Bearer x" },
      { name: "X-Custom", value: "secret" },
      { name: "Subject", value: "Test" },
    ])

    assert.deepEqual(
      headers.map((h) => h.name),
      ["From", "Subject"]
    )
  })

  it("buildAllowedProviderMetadata — pas de payload brut", () => {
    const metadata = buildAllowedProviderMetadata({
      id: "m1",
      historyId: "12345",
      payload: {
        headers: [{ name: "Message-ID", value: "<id@test>" }],
        parts: [{ body: { data: "abc" } }],
      },
    })

    const serialized = JSON.stringify(metadata)
    assert.equal(metadata.historyId, "12345")
    assert.equal(metadata.messageIdHeader, "<id@test>")
    assert.ok(!serialized.includes("payload"))
    assert.ok(!serialized.includes("abc"))
  })
})
