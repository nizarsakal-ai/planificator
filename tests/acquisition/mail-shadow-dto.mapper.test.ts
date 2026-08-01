/**
 * LOT-1C — mapper DTO Acquisition pur.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mapCanonicalMailToShadowDto } from "@/lib/acquisition/connector/mail-shadow-dto.mapper"
import type { CanonicalMailMessage } from "@/lib/acquisition/connector/connector.types"

function msg(over: Partial<CanonicalMailMessage> = {}): CanonicalMailMessage {
  return {
    externalMessageId: "ext-1",
    threadId: "t1",
    fromHeader: "a@example.com",
    subject: "Sujet secret",
    receivedAt: new Date("2026-08-01T10:00:00.000Z"),
    labels: [],
    snippet: null,
    attachments: [],
    providerMetadata: {},
    ...over,
  }
}

describe("mail-shadow-dto.mapper", () => {
  it("produit un DTO neutre avec connectionId", () => {
    const r = mapCanonicalMailToShadowDto(msg(), {
      companyId: "co1",
      connectionId: "conn1",
    })
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.dto.connectionId, "conn1")
      assert.equal(r.dto.externalId, "ext-1")
      assert.equal(r.dto.idempotencyKey, "ext-1")
      assert.equal("body" in r.dto, false)
      assert.equal(r.dto.payloadRef.startsWith("mail:"), true)
    }
  })

  it("LOT-2A : inclut subject normalisé ; jamais snippet/body/token", () => {
    const source = msg({
      subject: "  Sujet secret confidentiel  ",
      snippet: "corps partiel secret",
      fromHeader: "alice@example.com",
      providerMetadata: { raw: "<mime>secret</mime>", accessToken: "tok" },
    })
    const r = mapCanonicalMailToShadowDto(source, {
      companyId: "co1",
      connectionId: "conn1",
    })
    assert.equal(r.ok, true)
    if (!r.ok) return

    assert.equal(r.dto.message.subject, "Sujet secret confidentiel")
    assert.equal("subject" in r.dto, false)

    const serialized = JSON.stringify(r.dto)
    assert.equal(serialized.includes("corps partiel"), false)
    assert.equal(serialized.includes("<mime>"), false)
    assert.equal(serialized.includes("accessToken"), false)
    assert.equal(serialized.includes("tok"), false)

    assert.equal("snippet" in r.dto, false)
    assert.equal("labels" in r.dto, false)
    assert.equal("providerMetadata" in r.dto, false)
    assert.equal("attachments" in r.dto, false)
    assert.equal("fromHeader" in r.dto, false)
  })

  it("LOT-2A : subject whitespace-only omis", () => {
    const r = mapCanonicalMailToShadowDto(msg({ subject: "   " }), {
      companyId: "co1",
      connectionId: "conn1",
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.dto.message.subject, undefined)
  })

  it("LOT-2A : subject >512 tronqué Unicode-safe via normalizeSubject", () => {
    const emoji = "😀"
    const r = mapCanonicalMailToShadowDto(
      msg({ subject: emoji.repeat(520) }),
      { companyId: "co1", connectionId: "conn1" }
    )
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(Array.from(r.dto.message.subject!).length, 512)
  })

  it("refuse sans connectionId", () => {
    const r = mapCanonicalMailToShadowDto(msg(), {
      companyId: "co1",
      connectionId: "",
    })
    assert.equal(r.ok, false)
  })
})
