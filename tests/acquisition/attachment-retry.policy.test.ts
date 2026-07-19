process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  isRetryableAttachmentErrorCode,
  RETRYABLE_ATTACHMENT_ERROR_CODES,
} from "@/lib/acquisition/attachments/attachment-retry.policy"
import { computeRetrySchedule } from "@/lib/acquisition/attachments/attachment-retry-schedule"

describe("attachment-retry.policy", () => {
  it("allowlist exacte", () => {
    assert.deepEqual([...RETRYABLE_ATTACHMENT_ERROR_CODES], [
      "GMAIL_NOT_CONNECTED",
      "ATTACHMENT_STORAGE_FAILED",
    ])
  })

  it("codes allowlist retryables", () => {
    assert.equal(isRetryableAttachmentErrorCode("GMAIL_NOT_CONNECTED"), true)
    assert.equal(isRetryableAttachmentErrorCode("ATTACHMENT_STORAGE_FAILED"), true)
  })

  it("codes connus non retryables + inconnu deny by default", () => {
    assert.equal(isRetryableAttachmentErrorCode("GMAIL_ATTACHMENT_NOT_FOUND"), false)
    assert.equal(isRetryableAttachmentErrorCode("ATTACHMENT_DECODE_FAILED"), false)
    assert.equal(isRetryableAttachmentErrorCode("ATTACHMENT_STORAGE_COLLISION"), false)
    assert.equal(isRetryableAttachmentErrorCode("ATTACHMENT_PERSISTENCE_FAILED"), false)
    assert.equal(isRetryableAttachmentErrorCode("ATTACHMENT_MIME_NOT_ALLOWED"), false)
    assert.equal(isRetryableAttachmentErrorCode("ATTACHMENT_TOO_LARGE"), false)
    assert.equal(isRetryableAttachmentErrorCode("ATTACHMENT_SIGNATURE_MISMATCH"), false)
    assert.equal(isRetryableAttachmentErrorCode("UNKNOWN_CODE"), false)
    assert.equal(isRetryableAttachmentErrorCode(null), false)
    assert.equal(isRetryableAttachmentErrorCode(undefined), false)
  })
})

describe("computeRetrySchedule", () => {
  const now = new Date("2026-07-19T12:00:00.000Z")

  it("backoff déterministe avec random fixe", () => {
    const r = computeRetrySchedule({
      retryCount: 1,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      now,
      random: () => 0,
    })
    assert.equal(r.delayMs, 500)
    assert.equal(r.nextRetryAt.toISOString(), "2026-07-19T12:00:00.500Z")
  })

  it("jitter borné dans [0.5, 1.5) * capped", () => {
    const low = computeRetrySchedule({
      retryCount: 1,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      now,
      random: () => 0,
    })
    const high = computeRetrySchedule({
      retryCount: 1,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      now,
      random: () => 0.999,
    })
    assert.equal(low.delayMs, 500)
    assert.ok(high.delayMs >= 500 && high.delayMs < 1500)
  })

  it("cap maxDelay", () => {
    const r = computeRetrySchedule({
      retryCount: 20,
      baseDelayMs: 60_000,
      maxDelayMs: 120_000,
      now,
      random: () => 0.5,
    })
    assert.ok(r.delayMs <= 120_000)
  })

  it("absence d'overflow sur grands exposants", () => {
    const r = computeRetrySchedule({
      retryCount: 100,
      baseDelayMs: 1_000_000,
      maxDelayMs: 10_000,
      now,
      random: () => 0,
    })
    assert.equal(r.delayMs, 5_000)
    assert.ok(Number.isFinite(r.delayMs))
  })

  it("off-by-one : retryCount=1 → facteur 2^0", () => {
    const r = computeRetrySchedule({
      retryCount: 1,
      baseDelayMs: 2000,
      maxDelayMs: 100_000,
      now,
      random: () => 0.5,
    })
    assert.equal(r.delayMs, 2000)
  })
})
