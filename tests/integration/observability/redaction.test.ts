/**
 * LOT-1C — Gate-0 redaction (API + smoke CI).
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  REDACTED,
  redactError,
  redactLogFields,
  redactString,
} from "@/lib/integration/observability/redaction/redact"

describe("integration redaction", () => {
  it("redactString masque tokens et Bearer", () => {
    const s = redactString("Authorization: Bearer ya29.abc SECRET sk-ant-xyz123")
    assert.equal(s.includes("ya29"), false)
    assert.equal(s.includes("sk-ant"), false)
    assert.ok(s.includes(REDACTED))
  })

  it("redactString masque query access_token", () => {
    const s = redactString("https://x.test/cb?access_token=supersecret&ok=1")
    assert.equal(s.includes("supersecret"), false)
  })

  it("redactLogFields masque subject/body/email/stack", () => {
    const out = redactLogFields({
      companyId: "co1",
      subject: "Confidentiel",
      body: "texte brut",
      email: "a@b.c",
      stack: "Error: at provider",
      durationMs: 12,
    })
    assert.equal(out.companyId, "co1")
    assert.equal(out.durationMs, 12)
    assert.equal(out.subject, REDACTED)
    assert.equal(out.body, REDACTED)
    assert.equal(out.email, REDACTED)
    assert.equal(out.stack, REDACTED)
  })

  it("objet avec sender imbriqué → contenu masqué", () => {
    const out = redactLogFields({
      companyId: "co1",
      meta: { sender: "alice@example.com", role: "user" },
    })
    assert.equal(out.companyId, "co1")
    const meta = out.meta as Record<string, unknown>
    assert.equal(meta.sender, REDACTED)
    assert.equal(meta.role, "user")
    assert.equal(JSON.stringify(out).includes("alice@example.com"), false)
  })

  it("senderEmail / emailAddress / from / replyTo → masqués", () => {
    const out = redactLogFields({
      companyId: "co1",
      sender: "alice@example.com",
      senderEmail: "bob@example.com",
      sender_email: "carol@example.com",
      email: "dave@example.com",
      emailAddress: "erin@example.com",
      from: "frank@example.com",
      replyTo: "grace@example.com",
      durationMs: 3,
    })
    assert.equal(out.companyId, "co1")
    assert.equal(out.durationMs, 3)
    assert.equal(out.sender, REDACTED)
    assert.equal(out.senderEmail, REDACTED)
    assert.equal(out.sender_email, REDACTED)
    assert.equal(out.email, REDACTED)
    assert.equal(out.emailAddress, REDACTED)
    assert.equal(out.from, REDACTED)
    assert.equal(out.replyTo, REDACTED)
  })

  it("adresse email dans un texte libre → masquée", () => {
    const s = redactString("contact alice@example.com for details")
    assert.equal(s.includes("alice@example.com"), false)
    assert.ok(s.includes(REDACTED))
    assert.ok(s.includes("contact"))
    assert.ok(s.includes("for details"))
  })

  it("champs non sensibles restent intactes", () => {
    const out = redactLogFields({
      companyId: "co1",
      connectionId: "conn1",
      connectorType: "platform.mail.legacy",
      outcome: "normalized",
      durationMs: 42,
      count: 7,
      ok: true,
    })
    assert.equal(out.companyId, "co1")
    assert.equal(out.connectionId, "conn1")
    assert.equal(out.connectorType, "platform.mail.legacy")
    assert.equal(out.outcome, "normalized")
    assert.equal(out.durationMs, 42)
    assert.equal(out.count, 7)
    assert.equal(out.ok, true)
  })

  it("smoke CI : motifs sensibles absents après redaction", () => {
    const samples = [
      "Bearer tok_abc",
      "ya29.xyz",
      "body=rawmime",
      "Authorization: secretvalue",
    ]
    for (const sample of samples) {
      const redacted = redactString(sample)
      assert.equal(redacted.includes("tok_abc"), false)
      assert.equal(redacted.includes("ya29.xyz"), false)
      assert.equal(redacted.includes("secretvalue"), false)
    }
  })

  it("aucune régression sur Bearer / query token / Authorization", () => {
    assert.equal(
      redactString("Authorization: Bearer ya29.abc123").includes("ya29.abc123"),
      false
    )
    assert.equal(
      redactString("https://x.test/cb?access_token=supersecret&ok=1").includes(
        "supersecret"
      ),
      false
    )
    assert.ok(
      redactString("https://x.test/cb?access_token=supersecret&ok=1").includes(
        "ok=1"
      )
    )
  })

  it("redactError ne fuit pas de stack", () => {
    const err = new Error("provider boom token=abc")
    err.stack = "secret-stack"
    const r = redactError(err)
    assert.equal("stack" in r, false)
    assert.equal(r.message.includes("token=abc"), false)
  })
})
