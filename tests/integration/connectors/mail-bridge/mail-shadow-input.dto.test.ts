/**
 * LOT-1C — DTO MailShadow strict.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ZodError } from "zod"
import { parseMailShadowInputDto } from "@/lib/integration/connectors/mail-bridge/mail-shadow-input.dto"
import { MESSAGE_CONTENT_CAPABILITIES } from "@/lib/integration/types/message-content-capability"

function validDto(over: Record<string, unknown> = {}) {
  return {
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
    },
    ...over,
  }
}

describe("mail-shadow-input.dto", () => {
  it("accepte un DTO valide avec connectionId", () => {
    const dto = parseMailShadowInputDto(validDto())
    assert.equal(dto.connectionId, "conn1")
  })

  it("exige connectionId", () => {
    const { connectionId: _, ...rest } = validDto()
    assert.throws(() => parseMailShadowInputDto(rest), ZodError)
  })

  it("rejette champ inconnu (strict)", () => {
    assert.throws(
      () => parseMailShadowInputDto(validDto({ body: "raw" })),
      ZodError
    )
  })
})
