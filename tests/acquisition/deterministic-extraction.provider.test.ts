process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DeterministicExtractionProvider } from "@/lib/acquisition/extraction/deterministic-extraction.provider"
import {
  evaluateExtractionGate,
  normalizeProviderResult,
} from "@/lib/acquisition/extraction/extraction-normalize"

describe("DeterministicExtractionProvider R1", () => {
  const provider = new DeterministicExtractionProvider()

  async function gateFor(subject: string | null, body: string) {
    const raw = await provider.extract({
      subject,
      normalizedText: body,
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    const normalized = normalizeProviderResult(raw)
    return { raw, normalized, gate: evaluateExtractionGate(normalized.fields, normalized.warnings) }
  }

  it("signature commerciale >20 caractères → FAILED", async () => {
    const { gate, raw } = await gateFor(
      null,
      "Cordialement,\nL'équipe commerciale LAURALU\nTél 01 23 45 67 89"
    )
    assert.equal(raw.fields.description, undefined)
    assert.equal(gate.pass, false)
    assert.equal(gate.failureCode, "CONTENT_INSUFFICIENT")
  })

  it("Bonjour, merci de votre retour → FAILED", async () => {
    const { gate } = await gateFor(null, "Bonjour, merci de votre retour")
    assert.equal(gate.pass, false)
  })

  it("uniquement téléphone → FAILED", async () => {
    const { gate } = await gateFor(null, "Appelez le 06 12 34 56 78 merci.")
    assert.equal(gate.pass, false)
  })

  it("uniquement email → FAILED", async () => {
    const { gate } = await gateFor(null, "Contact: alice@example.com pour suite.")
    assert.equal(gate.pass, false)
  })

  it("uniquement date → FAILED", async () => {
    const { gate } = await gateFor(null, "Intervention prévue le 2026-08-01.")
    assert.equal(gate.pass, false)
  })

  it("uniquement code postal aveugle → FAILED (pas d'extraction CP)", async () => {
    const { raw, gate } = await gateFor(null, "Quantité 75001 pièces en stock.")
    assert.equal(raw.fields.postalCode, undefined)
    assert.equal(gate.pass, false)
  })

  it("sujet Relance devis ne devient pas worksiteName", async () => {
    const { raw, gate } = await gateFor("Relance devis", "Merci de revenir vers nous rapidement.")
    assert.equal(raw.fields.worksiteName, undefined)
    assert.equal(gate.pass, false)
  })

  it("référence explicite → PENDING_REVIEW", async () => {
    const { gate, normalized } = await gateFor(
      null,
      "Référence : CONSULT-12345\nMerci."
    )
    assert.equal(normalized.fields.consultationReference, "CONSULT-12345")
    assert.equal(gate.pass, true)
  })

  it("adresse qualifiée → PENDING_REVIEW", async () => {
    const { gate, normalized } = await gateFor(
      null,
      "Intervention au 12 rue de Rivoli 75001 Paris."
    )
    assert.ok(normalized.fields.address)
    assert.equal(gate.pass, true)
  })

  it("client clairement identifié → PENDING_REVIEW", async () => {
    const { gate, normalized } = await gateFor(
      null,
      "Client : Bouygues Construction\nMerci."
    )
    assert.equal(normalized.fields.clientName, "Bouygues Construction")
    assert.equal(gate.pass, true)
  })

  it("chantier labelé → worksiteName", async () => {
    const { gate, normalized } = await gateFor(
      "Consultation",
      "Chantier : Tour Alpha La Défense\nDu 2026-08-01 au 2026-08-15"
    )
    assert.equal(normalized.fields.worksiteName, "Tour Alpha La Défense")
    assert.equal(gate.pass, true)
  })

  it("date invalide calendaire ignorée", async () => {
    const raw = await provider.extract({
      subject: null,
      normalizedText: "Chantier : Site X\nDate 32/13/2026",
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    assert.equal(raw.fields.requestedStartDate, undefined)
  })

  it("confidence plafonnée ≤ 0.35", async () => {
    const raw = await provider.extract({
      subject: null,
      normalizedText: "Chantier : Site Y",
      locale: "fr-FR",
      attachmentMetadata: [],
      extractionSchemaVersion: "1",
    })
    for (const f of Object.values(raw.fields)) {
      if (f) assert.ok(f.confidence <= 0.35)
    }
  })
})
