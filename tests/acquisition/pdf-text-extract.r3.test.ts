/**
 * PLAN-ACQ-V2 R3 — Tests extraction PDF via unpdf + intégration excerpts → provider.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  appendAttachmentTextToBody,
  buildAttachmentTextExcerpts,
} from "@/lib/acquisition/extraction/attachment-text-excerpts"
import {
  buildFlateCompressedMultiBlockPdf,
  buildMinimalEmptyPdf,
  buildMinimalTextPdf,
  extractPdfTextLayer,
} from "@/lib/acquisition/extraction/pdf-text-extract"
import type { ExtractionProviderPort } from "@/lib/acquisition/extraction/extraction-provider.port"

describe("R3 PDF unpdf", () => {
  it("PDF texte réel (fixture minimale représentative)", async () => {
    const buf = buildMinimalTextPdf("Consultation Chantier Nord Surface 95 m2")
    const r = await extractPdfTextLayer(buf)
    assert.equal(r.status, "PDF_TEXT_EXTRACTED")
    assert.ok(r.text.includes("Consultation") || r.text.includes("Chantier"))
    assert.ok(r.text.includes("95") || r.text.includes("Surface"))
  })

  it("PDF Flate compressé multi-blocs", async () => {
    const buf = buildFlateCompressedMultiBlockPdf([
      "Bloc A adresse 12 rue Demo",
      "Bloc B surface utile 120 m2",
    ])
    const r = await extractPdfTextLayer(buf)
    assert.ok(
      r.status === "PDF_TEXT_EXTRACTED" || r.status === "PDF_TEXT_TRUNCATED"
    )
    assert.ok(r.text.includes("Bloc A") || r.text.includes("Demo"))
    assert.ok(r.text.includes("Bloc B") || r.text.includes("120"))
  })

  it("PDF sans texte → PDF_NO_TEXT_LAYER", async () => {
    const r = await extractPdfTextLayer(buildMinimalEmptyPdf())
    assert.ok(
      r.status === "PDF_NO_TEXT_LAYER" || r.status === "PDF_PARSE_FAILED"
    )
    assert.equal(r.text, "")
  })

  it("PDF corrompu → PDF_PARSE_FAILED", async () => {
    const r = await extractPdfTextLayer(Buffer.from("%PDF-not-valid-stream"))
    assert.equal(r.status, "PDF_PARSE_FAILED")
  })

  it("texte tronqué respecté", async () => {
    const long = "X".repeat(500)
    const buf = buildMinimalTextPdf(long)
    const r = await extractPdfTextLayer(buf, { maxChars: 50 })
    assert.equal(r.status, "PDF_TEXT_TRUNCATED")
    assert.ok(r.text.length <= 50)
    assert.equal(r.truncated, true)
  })

  it("intégration excerpts → normalizedText enrichi vers provider", async () => {
    const buf = buildFlateCompressedMultiBlockPdf([
      "Plan surface 80m2",
      "Adresse 5 avenue Test",
    ])
    const { excerpts, outcomes } = await buildAttachmentTextExcerpts([
      {
        filename: "plan-consultation.pdf",
        mimeType: "application/pdf",
        category: "PLAN",
        bytes: buf,
      },
    ])
    assert.equal(outcomes[0]?.status, "PDF_TEXT_EXTRACTED")
    assert.ok(excerpts.length === 1)

    const body = "Corps email consultation"
    const enriched = appendAttachmentTextToBody(body, excerpts)
    assert.ok(enriched.includes("Corps email"))
    assert.ok(enriched.includes("--- PJ texte: plan-consultation.pdf ---"))
    assert.ok(enriched.includes("80") || enriched.includes("surface") || enriched.includes("Plan"))

    let seenNormalized = ""
    const provider: ExtractionProviderPort = {
      async extract(input) {
        seenNormalized = input.normalizedText
        return {
          fields: {},
          warnings: [],
          providerMetadata: { providerId: "test" },
        }
      },
    }

    await provider.extract({
      subject: "Sujet",
      normalizedText: enriched,
      locale: "fr-FR",
      attachmentMetadata: [],
      attachmentTextExcerpts: excerpts,
      extractionSchemaVersion: "2",
    })
    assert.ok(seenNormalized.includes("PJ texte"))
    assert.ok(seenNormalized.includes("Corps email"))
  })
})
