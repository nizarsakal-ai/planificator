/**
 * LOT-1C — Family Normalizer MESSAGE.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { MailShadowInputDto } from "@/lib/integration/connectors/mail-bridge/mail-shadow-input.dto"
import { normalizeMessageFamily } from "@/lib/integration/normalizers/message/message-family-normalizer"
import { computeNormalizedMessageHash } from "@/lib/integration/normalizers/message/normalized-hash"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"

const baseDto = {
  companyId: "co1",
  connectionId: "conn1",
  externalId: "ext1",
  idempotencyKey: "idem1",
  receivedAt: "2026-08-01T10:00:00.000Z",
  occurredAt: "2026-08-01T09:00:00.000Z",
  payloadRef: "payload-ref",
  contentType: "message/rfc822",
  message: {
    externalMessageId: "ext1",
    contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
    subject: "Hello",
  },
} as MailShadowInputDto

describe("message-family-normalizer", () => {
  it("happy path + hash stable", () => {
    const a = normalizeMessageFamily(baseDto)
    const b = normalizeMessageFamily(baseDto)
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    if (a.ok && b.ok) {
      assert.equal(a.normalizedHash, b.normalizedHash)
      assert.equal(
        a.normalizedHash,
        computeNormalizedMessageHash(a.message)
      )
    }
  })

  it("sender vide → échec", () => {
    const r = normalizeMessageFamily({
      ...baseDto,
      message: {
        ...baseDto.message,
        sender: {},
      },
    } as MailShadowInputDto)
    assert.equal(r.ok, false)
  })

  it("LOT-2A : hash différent avec/sans subject", () => {
    const withSubject = normalizeMessageFamily(baseDto)
    const without = normalizeMessageFamily({
      ...baseDto,
      message: {
        externalMessageId: "ext1",
        contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
      },
    } as MailShadowInputDto)
    assert.equal(withSubject.ok, true)
    assert.equal(without.ok, true)
    if (withSubject.ok && without.ok) {
      assert.notEqual(withSubject.normalizedHash, without.normalizedHash)
      assert.equal(withSubject.message.subject, "Hello")
      assert.equal(without.message.subject, undefined)
    }
  })

  it("LOT-2A : normalizer revalide subject via normalizeSubject (troncature)", () => {
    const emoji = "😀"
    const r = normalizeMessageFamily({
      ...baseDto,
      message: {
        externalMessageId: "ext1",
        contentCapabilities: [MESSAGE_CONTENT_CAPABILITIES.CONTENT_INLINE],
        subject: emoji.repeat(600),
      },
    } as MailShadowInputDto)
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(Array.from(r.message.subject!).length, 512)
    }
  })
})
