import { it } from "node:test"
import assert from "node:assert/strict"
import { mapAnthropicRawToProviderResult } from "@/lib/acquisition/extraction/anthropic-extraction.schema"
import { normalizeProviderResult, applyDeterministicPostEnrichment } from "@/lib/acquisition/extraction/extraction-normalize"

it("a saturated provider warning list preserves adapter safety warnings within the cap", () => {
  const result = mapAnthropicRawToProviderResult({
    raw: { fields: {}, warnings: Array.from({ length: 50 }, () => ({ code: "LOW_CONFIDENCE" })) },
    haystack: "", model: "test", latencyMs: 1,
    extraWarningCodes: ["VISUAL_INPUTS_DROPPED", "PROVIDER_PARTIAL_RESULT"],
  })
  assert.equal(result.warnings.length, 50)
  assert.equal(result.warnings[0].code, "VISUAL_INPUTS_DROPPED")
})

it("conflicting explicit intervention starts remain unset while the end is preserved", () => {
  const normalized = normalizeProviderResult({
    fields: {
      requestedStartDate: { value: "2026-10-19", confidence: 0.8 },
      requestedEndDate: { value: "2026-11-27", confidence: 0.8 },
    }, warnings: [], providerMetadata: { providerId: "test" },
  })
  const result = applyDeterministicPostEnrichment(normalized, {
    subject: "CONSULTATION SITE 11-19/11 AU 27/11",
    body: "Dates intervention : du 19/10/2026 au 27/11/2026 - 7 jours",
  })
  assert.equal(result.fields.requestedStartDate, null)
  assert.equal(result.fields.requestedEndDate, "2026-11-27")
  assert.ok(result.warnings.some(w => w.code === "DATE_AMBIGUOUS" && w.field === "requestedStartDate"))
})

// Incident 16/11/2026 — PROVIDER_INVALID_OUTPUT « too_big » : la sortie brute
// dépassait les maxLength du schéma d'outil (non garantis par l'API).
it("citation > 120 caractères : tronquée, extraction conservée, contrôle de présence maintenu", () => {
  const sentence =
    "Pouvez-vous m'envoyer votre devis pour l'installation d'une structure 12.4X45H7.5 sous réserve de disponibilité de vos équipes la semaine 50"
  const result = mapAnthropicRawToProviderResult({
    raw: {
      fields: {
        worksiteName: { value: "ARENA SPORT", confidence: 0.9, evidence: { source: "BODY", quote: sentence } },
        description: { value: "Installation structure", confidence: 0.8, evidence: { source: "BODY", quote: "x".repeat(300) } },
      },
      warnings: [],
    },
    haystack: `Bonjour, ${sentence}. Cordialement`,
    model: "test",
    latencyMs: 1,
  })
  assert.equal(result.fields.worksiteName?.value, "ARENA SPORT")
  assert.equal(result.fields.worksiteName?.evidence?.quote?.length, 120)
  // Citation absente du texte : champ non fort conservé avec confiance plafonnée, sans preuve.
  assert.equal(result.fields.description?.confidence, 0.35)
  assert.equal(result.fields.description?.evidence, undefined)
})

it("warnings trop longs ou trop nombreux, citation vide : tolérés", () => {
  const result = mapAnthropicRawToProviderResult({
    raw: {
      fields: {
        city: { value: "Paris", confidence: 0.85, evidence: { source: "BODY", quote: "   " } },
      },
      warnings: [
        { code: "LOW_CONFIDENCE", field: "f".repeat(80) },
        ...Array.from({ length: 70 }, () => ({ code: "C".repeat(90) })),
      ],
    },
    haystack: "Paris",
    model: "test",
    latencyMs: 1,
  })
  assert.equal(result.fields.city?.value, "Paris")
  assert.ok((result.fields.city?.confidence ?? 0) <= 0.85)
  assert.equal(result.fields.city?.evidence, undefined)
  assert.ok(result.warnings.length <= 50)
})

it("source de preuve inconnue, confiance négative ou > 1 : toujours rejeté (garde-fou conservé)", () => {
  assert.throws(
    () => mapAnthropicRawToProviderResult({
      raw: { fields: { city: { value: "Paris", confidence: 1.5 } }, warnings: [] },
      haystack: "Paris", model: "t", latencyMs: 1,
    }),
    /PROVIDER_INVALID_OUTPUT/
  )
  assert.throws(
    () => mapAnthropicRawToProviderResult({
      raw: { fields: { city: { value: "Paris", confidence: -1 } }, warnings: [] },
      haystack: "Paris", model: "t", latencyMs: 1,
    }),
    /PROVIDER_INVALID_OUTPUT/
  )
  assert.throws(
    () => mapAnthropicRawToProviderResult({
      raw: { fields: { city: { value: "Paris", confidence: 0.5, evidence: { source: "INVENTED", quote: "Paris" } } }, warnings: [] },
      haystack: "Paris", model: "t", latencyMs: 1,
    }),
    /PROVIDER_INVALID_OUTPUT/
  )
})
