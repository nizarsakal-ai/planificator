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
