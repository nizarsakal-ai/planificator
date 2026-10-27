import { it } from "node:test"
import assert from "node:assert/strict"
import { normalizeProviderResult, applyDeterministicPostEnrichment } from "@/lib/acquisition/extraction/extraction-normalize"

function extract(fields: Record<string, unknown>, body: string, subject: string | null = null) {
  return applyDeterministicPostEnrichment(normalizeProviderResult({
    fields, warnings: [], providerMetadata: { providerId: "anthropic" },
  }), { body, subject, receivedAt: new Date("2026-10-26T12:00:00Z") })
}
const field = (value: string, quote: string, source = "BODY") => ({ value, confidence: 0.8, evidence: { source, quote } })

it("three-error regression: end client is separated, signed date removed, French phone normalized", () => {
  const body = "Pour notre client :\nMAIRIE TEST\nT : (+33) 05 12 34 56 78\nDates intervention : du 19/10/2026 au 27/11/2026"
  const r = extract({
    clientName: field("MAIRIE TEST", "MAIRIE TEST"),
    clientConsultationDate: field("2026-10-21", "Bon pour accord le 21/10/2026", "ATTACHMENT_VISUAL"),
    contactPhone: field("+330512345678", "(+33) 05 12 34 56 78"),
    requestedStartDate: field("2026-10-19", "19/10/2026"),
    requestedEndDate: field("2026-11-27", "27/11/2026"),
  }, body, "CONSULTATION 19/11 AU 27/11")
  assert.equal(r.fields.clientName, null)
  assert.equal(r.fields.endClientName, "MAIRIE TEST")
  assert.equal(r.fields.clientConsultationDate, null)
  assert.equal(r.fields.contactPhone, "+33512345678")
  assert.equal(r.fields.requestedStartDate, null)
  assert.equal(r.fields.requestedEndDate, "2026-11-27")
  assert.ok(r.warnings.some(w => w.code === "CLIENT_IDENTITY_AMBIGUOUS"))
  assert.ok(r.warnings.some(w => w.code === "DATE_AMBIGUOUS" && w.field === "clientConsultationDate"))
  assert.equal(r.confidenceData.clientName, undefined)
  assert.equal(r.evidenceData.clientConsultationDate, undefined)
})

it("recovers only an explicitly labelled unique donor, never a company inferred from a domain", () => {
  const fields = { clientName: field("MAIRIE TEST", "MAIRIE TEST") }
  assert.equal(extract(fields, "Donneur d’ordre : LOUEUR EXEMPLE\nClient final : MAIRIE TEST").fields.clientName, "LOUEUR EXEMPLE")
  assert.equal(extract(fields, "Donneur d'ordre : AAAAA\nDonneur d'ordre : BBBBB\nClient final : MAIRIE TEST").fields.clientName, null)
  assert.equal(extract(fields, "Pour notre client : MAIRIE TEST\ncontact@exemple.fr").fields.clientName, null)
})

it("preserves a correct donor and existing end-client distinction", () => {
  const r = extract({ clientName: field("LOUEUR EXEMPLE", "LOUEUR EXEMPLE"), endClientName: field("MAIRIE TEST", "MAIRIE TEST") },
    "LOUEUR EXEMPLE\nPour notre client : MAIRIE TEST")
  assert.equal(r.fields.clientName, "LOUEUR EXEMPLE")
  assert.equal(r.fields.endClientName, "MAIRIE TEST")
})

it("retains explicit consultation issue dates in text and visual quotes, including French month names", () => {
  for (const quote of ["Date de consultation : 20/08/2026", "Consultation du 20 août 2026", "Date d’émission de la consultation : 2026-08-20"]) {
    for (const source of ["BODY", "ATTACHMENT_VISUAL"]) {
      const r = extract({ clientConsultationDate: field("2026-08-20", quote, source) }, source === "BODY" ? quote : "Mail sans date")
      assert.equal(r.fields.clientConsultationDate, "2026-08-20")
    }
  }
})

it("rejects agreement, signature, revision, reception, absent proof and mismatching date values", () => {
  for (const quote of ["Bon pour accord le 21/10/2026", "Signé le 21.10.26", "Révision du 21/10/2026", "Reçu le 21/10/2026", "Date de consultation : 20/10/2026"]) {
    assert.equal(extract({ clientConsultationDate: field("2026-10-21", quote) }, quote).fields.clientConsultationDate, null)
  }
  assert.equal(extract({ clientConsultationDate: { value: "2026-10-21", confidence: 0.8 } }, "Date de consultation : 21/10/2026").fields.clientConsultationDate, null)
})

it("normalizes French phone variants for contact and company without altering foreign codes", () => {
  for (const value of ["05 12 34 56 78", "(+33) 05 12 34 56 78", "+33 (0)5 12 34 56 78", "0033 05 12 34 56 78", "+33512345678"]) {
    const r = extract({ contactPhone: field(value, value), clientPhone: field(value, value) }, value)
    assert.equal(r.fields.contactPhone, "+33512345678")
    assert.equal(r.fields.clientPhone, "+33512345678")
  }
  for (const value of ["+390669812345", "+49301234567", "+12125551234"]) {
    assert.equal(extract({ contactPhone: field(value, value) }, value).fields.contactPhone, value)
  }
})
