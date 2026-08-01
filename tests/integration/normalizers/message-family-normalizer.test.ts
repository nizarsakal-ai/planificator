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
})
