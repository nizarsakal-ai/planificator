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

  it("n’inclut pas subject ni payload Gmail brut dans le DTO bridge", () => {
    const source = msg({
      subject: "Sujet secret confidentiel",
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

    // Explicit : subject absent du DTO (racine et message)
    assert.equal("subject" in r.dto, false)
    assert.equal("subject" in r.dto.message, false)
    assert.equal(r.dto.message.subject, undefined)

    const serialized = JSON.stringify(r.dto)
    assert.equal(serialized.includes("Sujet secret"), false)
    assert.equal(serialized.includes("corps partiel"), false)
    assert.equal(serialized.includes("<mime>"), false)
    assert.equal(serialized.includes("accessToken"), false)
    assert.equal(serialized.includes("tok"), false)

    // Mapper pur : pas de body / snippet / labels / providerMetadata transmis
    assert.equal("snippet" in r.dto, false)
    assert.equal("labels" in r.dto, false)
    assert.equal("providerMetadata" in r.dto, false)
    assert.equal("attachments" in r.dto, false)
    assert.equal("fromHeader" in r.dto, false)
  })

  it("refuse sans connectionId", () => {
    const r = mapCanonicalMailToShadowDto(msg(), {
      companyId: "co1",
      connectionId: "",
    })
    assert.equal(r.ok, false)
  })
})
