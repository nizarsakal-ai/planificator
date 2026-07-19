process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractTextPartsFromPayload } from "@/lib/acquisition/content/message-content-mime"
import type { GmailMessagePayload } from "@/lib/acquisition/connector/gmail-api.types"

function b64url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

describe("message-content-mime", () => {
  it("extrait text/plain et ignore les attachments", () => {
    const payload: GmailMessagePayload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "text/plain",
          body: { data: b64url("Corps plain"), size: 11 },
        },
        {
          mimeType: "application/pdf",
          filename: "plan.pdf",
          body: { attachmentId: "att1", data: b64url("BINARY"), size: 6 },
        },
        {
          mimeType: "text/html",
          body: { data: b64url("<p>Html</p>"), size: 10 },
        },
      ],
    }
    const out = extractTextPartsFromPayload(payload)
    assert.equal(out.textPlain, "Corps plain")
    assert.equal(out.textHtml, "<p>Html</p>")
    assert.ok(!out.textPlain?.includes("BINARY"))
  })

  it("message simple text/plain racine", () => {
    const payload: GmailMessagePayload = {
      mimeType: "text/plain",
      body: { data: b64url("Hello root"), size: 10 },
    }
    const out = extractTextPartsFromPayload(payload)
    assert.equal(out.textPlain, "Hello root")
    assert.equal(out.mimeType, "text/plain")
  })
})
