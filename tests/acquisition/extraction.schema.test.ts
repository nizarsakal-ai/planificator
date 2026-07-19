process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  catalogWarning,
  extractionCanonicalFieldsSchema,
  extractionProviderResultSchema,
  EXTRACTION_WARNING_CATALOG,
  isValidCalendarIsoDate,
} from "@/lib/acquisition/extraction/extraction.schema"
import {
  evaluateExtractionGate,
  hasStrongBusinessSignal,
  normalizeProviderResult,
} from "@/lib/acquisition/extraction/extraction-normalize"

describe("extraction.schema", () => {
  it("valide un résultat provider minimal (objet fermé)", () => {
    const parsed = extractionProviderResultSchema.parse({
      fields: {
        worksiteName: {
          value: "Chantier Test",
          confidence: 0.333,
          evidence: { source: "BODY", quote: "Chantier Test" },
        },
      },
      warnings: [],
      providerMetadata: { providerId: "deterministic" },
    })
    assert.equal(parsed.fields.worksiteName?.confidence, 0.33)
  })

  it("rejette clés fields inconnues (.strict)", () => {
    const r = extractionProviderResultSchema.safeParse({
      fields: { unknownEvil: { value: "x", confidence: 0.2 } },
      warnings: [],
      providerMetadata: { providerId: "deterministic" },
    })
    assert.equal(r.success, false)
  })

  it("rejette NaN / Infinity confidence", () => {
    const nan = extractionProviderResultSchema.safeParse({
      fields: { worksiteName: { value: "A", confidence: Number.NaN } },
      warnings: [],
      providerMetadata: { providerId: "d" },
    })
    assert.equal(nan.success, false)
    const inf = extractionProviderResultSchema.safeParse({
      fields: { worksiteName: { value: "A", confidence: Number.POSITIVE_INFINITY } },
      warnings: [],
      providerMetadata: { providerId: "d" },
    })
    assert.equal(inf.success, false)
  })

  it("tronque evidence quote à 120", () => {
    const long = "x".repeat(200)
    const parsed = extractionProviderResultSchema.parse({
      fields: {
        description: {
          value: "ok",
          confidence: 0.2,
          evidence: { source: "BODY", quote: long },
        },
      },
      warnings: [],
      providerMetadata: { providerId: "deterministic" },
    })
    assert.equal((parsed.fields.description?.evidence as { quote?: string } | undefined)?.quote?.length, 120)
  })

  it("valide calendrier ISO sans rollover", () => {
    assert.equal(isValidCalendarIsoDate("2026-07-19"), true)
    assert.equal(isValidCalendarIsoDate("2026-02-30"), false)
    assert.equal(isValidCalendarIsoDate("2026-13-01"), false)
  })

  it("catalogue warnings blocking", () => {
    assert.equal(EXTRACTION_WARNING_CATALOG.DATE_RANGE_INVALID.blocking, true)
    assert.equal(EXTRACTION_WARNING_CATALOG.INVALID_EMAIL.blocking, false)
    const w = catalogWarning("EMPTY_EXTRACTION")
    assert.equal(w.severity, "ERROR")
  })

  it("normalise dates ISO et emails", () => {
    const fields = extractionCanonicalFieldsSchema.parse({
      worksiteName: "  Site A  ",
      clientEmail: "  Jean.Dupont@Example.COM ",
      requestedStartDate: "2026-07-01",
      requestedEndDate: "2026-07-10",
    })
    assert.equal(fields.worksiteName, "Site A")
    assert.equal(fields.clientEmail, "jean.dupont@example.com")
  })
})

describe("extraction-normalize gate R1", () => {
  it("hasStrongBusinessSignal ignore description seule", () => {
    assert.equal(
      hasStrongBusinessSignal({
        worksiteName: null,
        clientName: null,
        clientEmail: null,
        clientPhone: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        address: null,
        postalCode: null,
        city: null,
        requestedStartDate: null,
        requestedEndDate: null,
        consultationReference: null,
        description: "Signature commerciale très longue de plus de vingt caractères",
        attachmentClassifications: [],
      }),
      false
    )
  })

  it("PENDING_REVIEW si worksiteName fort", () => {
    const normalized = normalizeProviderResult({
      fields: {
        worksiteName: { value: "Tour Alpha", confidence: 0.35 },
      },
      warnings: [],
      providerMetadata: { providerId: "deterministic" },
    })
    const gate = evaluateExtractionGate(normalized.fields, normalized.warnings)
    assert.equal(gate.pass, true)
  })

  it("FAILED CONTENT_INSUFFICIENT si description seule", () => {
    const normalized = normalizeProviderResult({
      fields: {
        description: {
          value: "Cordialement, l'équipe commerciale LAURALU vous remercie.",
          confidence: 0.25,
        },
      },
      warnings: [],
      providerMetadata: { providerId: "deterministic" },
    })
    const gate = evaluateExtractionGate(normalized.fields, normalized.warnings)
    assert.equal(gate.pass, false)
    assert.equal(gate.failureCode, "CONTENT_INSUFFICIENT")
  })

  it("FAILED si dates inversées", () => {
    const normalized = normalizeProviderResult({
      fields: {
        worksiteName: { value: "Site", confidence: 0.35 },
        requestedStartDate: { value: "2026-07-20", confidence: 0.3 },
        requestedEndDate: { value: "2026-07-10", confidence: 0.3 },
      },
      warnings: [],
      providerMetadata: { providerId: "deterministic" },
    })
    const gate = evaluateExtractionGate(normalized.fields, normalized.warnings)
    assert.equal(gate.pass, false)
    assert.equal(gate.failureCode, "DATE_RANGE_INVALID")
  })

  it("FAILED si aucun signal fort (dates seules)", () => {
    const normalized = normalizeProviderResult({
      fields: {
        requestedStartDate: { value: "2026-07-01", confidence: 0.3 },
      },
      warnings: [],
      providerMetadata: { providerId: "deterministic" },
    })
    const gate = evaluateExtractionGate(normalized.fields, normalized.warnings)
    assert.equal(gate.pass, false)
    assert.equal(gate.failureCode, "CONTENT_INSUFFICIENT")
  })

  it("email invalide droppé non bloquant si worksiteName OK", () => {
    const normalized = normalizeProviderResult({
      fields: {
        worksiteName: { value: "Site", confidence: 0.35 },
        clientEmail: { value: "pas-un-email", confidence: 0.3 },
      },
      warnings: [],
      providerMetadata: { providerId: "deterministic" },
    })
    assert.equal(normalized.fields.clientEmail, null)
    assert.ok(normalized.warnings.some((w) => w.code === "INVALID_EMAIL"))
    const gate = evaluateExtractionGate(normalized.fields, normalized.warnings)
    assert.equal(gate.pass, true)
  })

  it("message provider hostile jamais persisté dans warningData", () => {
    const secret = "sk-ANT-SECRET-LEAK-BODY-EMAIL"
    const normalized = normalizeProviderResult({
      fields: {
        worksiteName: { value: "Site", confidence: 0.35 },
      },
      warnings: [
        {
          code: "UNSUPPORTED_ATTACHMENT_TYPE",
          message: secret,
          field: "attachmentClassifications",
        },
        {
          code: "UNKNOWN_EVIL_CODE",
          message: secret,
        },
      ],
      providerMetadata: { providerId: "deterministic" },
    })
    const dumped = JSON.stringify(normalized.warnings)
    assert.equal(dumped.includes(secret), false)
    assert.ok(normalized.warnings.every((w) => !w.message.includes(secret)))
    assert.ok(normalized.warnings.some((w) => w.code === "PROVIDER_PARTIAL_RESULT"))
  })

  it("référence + adresse comptent comme signaux forts", () => {
    assert.equal(
      hasStrongBusinessSignal({
        worksiteName: null,
        clientName: null,
        clientEmail: null,
        clientPhone: null,
        contactName: null,
        contactEmail: null,
        contactPhone: null,
        address: "12 rue de la Paix Paris",
        postalCode: null,
        city: null,
        requestedStartDate: null,
        requestedEndDate: null,
        consultationReference: "REF-99",
        description: null,
        attachmentClassifications: [],
      }),
      true
    )
  })
})
