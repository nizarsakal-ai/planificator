process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mapHttpStatusToGmailError, GmailProviderError } from "@/lib/acquisition/connector/gmail.errors"
import { FetchGmailApiClient } from "@/lib/acquisition/connector/gmail-api.client"

describe("gmail.errors", () => {
  it("401 → GMAIL_UNAUTHORIZED non retryable + httpStatus 401", () => {
    const err = mapHttpStatusToGmailError(401, "profile")
    assert.equal(err.code, "GMAIL_UNAUTHORIZED")
    assert.equal(err.retryable, false)
    assert.equal(err.global, true)
    assert.equal(err.httpStatus, 401)
  })

  it("403 → GMAIL_UNAUTHORIZED non retryable + httpStatus 403", () => {
    const err = mapHttpStatusToGmailError(403, "profile")
    assert.equal(err.code, "GMAIL_UNAUTHORIZED")
    assert.equal(err.retryable, false)
    assert.equal(err.httpStatus, 403)
  })

  it("429 → GMAIL_RATE_LIMITED retryable", () => {
    const err = mapHttpStatusToGmailError(429, "list")
    assert.equal(err.code, "GMAIL_RATE_LIMITED")
    assert.equal(err.retryable, true)
    assert.equal(err.global, true)
    assert.equal(err.httpStatus, 429)
  })

  it("5xx → GMAIL_UNAVAILABLE retryable", () => {
    const err = mapHttpStatusToGmailError(503, "message")
    assert.equal(err.code, "GMAIL_UNAVAILABLE")
    assert.equal(err.retryable, true)
    assert.equal(err.httpStatus, 503)
  })

  it("404 history → GMAIL_HISTORY_EXPIRED retryable", () => {
    const err = mapHttpStatusToGmailError(404, "history")
    assert.equal(err.code, "GMAIL_HISTORY_EXPIRED")
    assert.equal(err.retryable, true)
    assert.equal(err.httpStatus, 404)
  })

  it("404 message → GMAIL_MESSAGE_NOT_FOUND non retryable", () => {
    const err = mapHttpStatusToGmailError(404, "message", "mid-1")
    assert.equal(err.code, "GMAIL_MESSAGE_NOT_FOUND")
    assert.equal(err.retryable, false)
    assert.equal(err.messageId, "mid-1")
    assert.equal(err.httpStatus, 404)
  })

  it("constructeur sans httpStatus reste compatible", () => {
    const err = new GmailProviderError({
      code: "GMAIL_NOT_CONNECTED",
      message: "non connecté",
      retryable: false,
      global: false,
    })
    assert.equal(err.httpStatus, undefined)
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

describe("FetchGmailApiClient.getProfile httpStatus", () => {
  it("401 conserve httpStatus=401 et codes inchangés", async () => {
    const prev = globalThis.fetch
    globalThis.fetch = async () => new Response("secret-body", { status: 401 }) as never
    try {
      const client = new FetchGmailApiClient()
      await assert.rejects(
        () => client.getProfile("tok"),
        (err: unknown) => {
          assert.ok(err instanceof GmailProviderError)
          assert.equal(err.httpStatus, 401)
          assert.equal(err.code, "GMAIL_UNAUTHORIZED")
          assert.equal(err.retryable, false)
          assert.equal(err.global, true)
          return true
        }
      )
    } finally {
      globalThis.fetch = prev
    }
  })

  it("403 conserve httpStatus=403 (distinct de 401)", async () => {
    const prev = globalThis.fetch
    globalThis.fetch = async () => new Response("secret-body", { status: 403 }) as never
    try {
      const client = new FetchGmailApiClient()
      await assert.rejects(
        () => client.getProfile("tok"),
        (err: unknown) => {
          assert.ok(err instanceof GmailProviderError)
          assert.equal(err.httpStatus, 403)
          assert.equal(err.code, "GMAIL_UNAUTHORIZED")
          assert.equal(err.retryable, false)
          return true
        }
      )
    } finally {
      globalThis.fetch = prev
    }
  })
})
