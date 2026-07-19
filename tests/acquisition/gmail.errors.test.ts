process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mapHttpStatusToGmailError, GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"

describe("gmail.errors", () => {
  it("401 → GMAIL_UNAUTHORIZED non retryable", () => {
    const err = mapHttpStatusToGmailError(401, "list")
    assert.equal(err.code, "GMAIL_UNAUTHORIZED")
    assert.equal(err.retryable, false)
    assert.equal(err.global, true)
  })

  it("403 → GMAIL_UNAUTHORIZED non retryable", () => {
    const err = mapHttpStatusToGmailError(403, "list")
    assert.equal(err.code, "GMAIL_UNAUTHORIZED")
    assert.equal(err.retryable, false)
  })

  it("429 → GMAIL_RATE_LIMITED retryable", () => {
    const err = mapHttpStatusToGmailError(429, "list")
    assert.equal(err.code, "GMAIL_RATE_LIMITED")
    assert.equal(err.retryable, true)
    assert.equal(err.global, true)
  })

  it("5xx → GMAIL_UNAVAILABLE retryable", () => {
    const err = mapHttpStatusToGmailError(503, "message")
    assert.equal(err.code, "GMAIL_UNAVAILABLE")
    assert.equal(err.retryable, true)
  })

  it("404 history → GMAIL_HISTORY_EXPIRED retryable", () => {
    const err = mapHttpStatusToGmailError(404, "history")
    assert.equal(err.code, "GMAIL_HISTORY_EXPIRED")
    assert.equal(err.retryable, true)
  })

  it("404 message → GMAIL_MESSAGE_NOT_FOUND non retryable", () => {
    const err = mapHttpStatusToGmailError(404, "message", "mid-1")
    assert.equal(err.code, "GMAIL_MESSAGE_NOT_FOUND")
    assert.equal(err.retryable, false)
    assert.equal(err.messageId, "mid-1")
  })

  it("ne contient pas de token dans le message", () => {
    const err = new GmailProviderError({
      code: "GMAIL_TOKEN_REFRESH_FAILED",
      message: "Échec du refresh token",
      retryable: false,
      global: true,
    })
    assert.ok(!err.message.includes("Bearer"))
    assert.ok(!err.message.includes("refresh_token"))
    assert.ok(!err.message.includes("access_token"))
  })
})
