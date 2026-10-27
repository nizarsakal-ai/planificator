/**
 * PLAN-ACQ-MULTIMODAL — Lecture des pièces jointes (texte, xlsx, vision, plafonds).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  MAX_VISUAL_FILES,
  isPotentiallyReadableAttachment,
  readAttachmentsForExtraction,
  shouldLoadAttachmentBytes,
  type AttachmentForReading,
} from "@/lib/acquisition/extraction/attachment-reading"
import { buildMinimalEmptyPdf, buildMinimalTextPdf } from "@/lib/acquisition/extraction/pdf-text-extract"
import {
  buildBlankPdfWithPages,
  buildMinimalHeic,
  buildMinimalJpeg,
  buildXlsx,
} from "./helpers/multimodal-fixtures"

const VISION_ON = { vision: { enabled: true as const } }
const VISION_OFF = { vision: { enabled: false as const, reason: "FLAG_OFF" as const } }

function att(over: Partial<AttachmentForReading> & { filename: string }): AttachmentForReading {
  return {
    mimeType: "application/octet-stream",
    category: "UNKNOWN",
    sizeBytes: over.bytes?.byteLength ?? 10,
    status: "STORED",
    bytes: null,
    ...over,
  }
}

describe("readAttachmentsForExtraction", () => {
  it("PDF texte → extrait texte + outcome READ_TEXT + compat PDF_TEXT_EXTRACTED", async () => {
    const r = await readAttachmentsForExtraction(
      [att({ filename: "BC.pdf", mimeType: "application/pdf", category: "PLAN", bytes: buildMinimalTextPdf("Bon de commande ACME 12 rue Haute") })],
      VISION_OFF
    )
    assert.equal(r.excerpts.length, 1)
    assert.match(r.excerpts[0].text, /Bon de commande ACME/)
    assert.deepEqual(r.outcomes, [{ filename: "BC.pdf", kind: "pdf", outcome: "READ_TEXT" }])
    assert.deepEqual(r.pdfOutcomes, [{ filename: "BC.pdf", status: "PDF_TEXT_EXTRACTED" }])
    assert.equal(r.visuals.length, 0)
  })

  it("PDF scanné + vision ON → bloc document base64", async () => {
    const pdf = buildMinimalEmptyPdf()
    const r = await readAttachmentsForExtraction(
      [att({ filename: "scan.pdf", mimeType: "application/pdf", bytes: pdf })],
      VISION_ON
    )
    assert.equal(r.excerpts.length, 0)
    assert.equal(r.visuals.length, 1)
    assert.equal(r.visuals[0].kind, "pdf")
    assert.equal(r.visuals[0].mediaType, "application/pdf")
    assert.equal(Buffer.from(r.visuals[0].base64, "base64").equals(pdf), true)
    assert.deepEqual(r.outcomes[0], { filename: "scan.pdf", kind: "pdf", outcome: "READ_VISION" })
    assert.deepEqual(r.pdfOutcomes, [{ filename: "scan.pdf", status: "PDF_NO_TEXT_LAYER" }])
  })

  it("PDF scanné + vision OFF → ignoré (FLAG_OFF), aucun visuel", async () => {
    const r = await readAttachmentsForExtraction(
      [att({ filename: "scan.pdf", mimeType: "application/pdf", bytes: buildMinimalEmptyPdf() })],
      VISION_OFF
    )
    assert.equal(r.visuals.length, 0)
    assert.deepEqual(r.outcomes[0], {
      filename: "scan.pdf",
      kind: "pdf",
      outcome: "IGNORED_VISION_DISABLED",
      reason: "FLAG_OFF",
    })
  })

  it("provider non vision (deterministic) → raison PROVIDER_NOT_VISION", async () => {
    const r = await readAttachmentsForExtraction(
      [att({ filename: "IMG_2635.jpeg", bytes: buildMinimalJpeg() })],
      { vision: { enabled: false, reason: "PROVIDER_NOT_VISION" } }
    )
    assert.equal(r.visuals.length, 0)
    assert.equal(r.outcomes[0].outcome, "IGNORED_VISION_DISABLED")
    assert.equal(r.outcomes[0].reason, "PROVIDER_NOT_VISION")
  })

  it("JPEG déclaré octet-stream, catégorie UNKNOWN → bloc image/jpeg", async () => {
    const r = await readAttachmentsForExtraction(
      [att({ filename: "IMG_2635.jpeg", mimeType: "application/octet-stream", category: "UNKNOWN", bytes: buildMinimalJpeg() })],
      VISION_ON
    )
    assert.equal(r.visuals.length, 1)
    assert.equal(r.visuals[0].kind, "image")
    assert.equal(r.visuals[0].mediaType, "image/jpeg")
    assert.equal(r.outcomes[0].outcome, "READ_VISION")
  })

  it("HEIC ignoré avec issue explicite, même vision ON (aucune conversion)", async () => {
    const r = await readAttachmentsForExtraction(
      [
        att({ filename: "IMG_1.HEIC", mimeType: "image/heic", bytes: buildMinimalHeic() }),
        att({ filename: "photo.jpg", mimeType: "image/jpeg", bytes: buildMinimalHeic() }),
      ],
      VISION_ON
    )
    assert.equal(r.visuals.length, 0)
    assert.deepEqual(
      r.outcomes.map((o) => o.outcome),
      ["IGNORED_HEIC", "IGNORED_HEIC"]
    )
  })

  it("xlsx → texte ' | ' ; xlsx corrompu → FAILED ; format inconnu → IGNORED_FORMAT", async () => {
    const xlsx = await buildXlsx([{ name: "Croquis", rows: [["Client", "ACME"], ["GPS", "48.85, 2.35"]] }])
    const r = await readAttachmentsForExtraction(
      [
        att({ filename: "TEMPLATE_CROQUIS.xlsx", bytes: xlsx }),
        att({ filename: "casse.xlsx", bytes: Buffer.from("PK\x03\x04 broken") }),
        att({ filename: "plan.dwg", bytes: Buffer.from("AC1032....") }),
      ],
      VISION_OFF
    )
    assert.equal(r.excerpts.length, 1)
    assert.match(r.excerpts[0].text, /Client \| ACME/)
    assert.deepEqual(
      r.outcomes.map((o) => [o.filename, o.outcome]),
      [
        ["TEMPLATE_CROQUIS.xlsx", "READ_TEXT"],
        ["casse.xlsx", "FAILED"],
        ["plan.dwg", "IGNORED_FORMAT"],
      ]
    )
  })

  it("pièce non STORED → UNAVAILABLE ; bytes absents → UNAVAILABLE", async () => {
    const r = await readAttachmentsForExtraction(
      [
        att({ filename: "a.pdf", mimeType: "application/pdf", status: "DISCOVERED" }),
        att({ filename: "b.pdf", mimeType: "application/pdf", bytes: null }),
      ],
      VISION_OFF
    )
    assert.deepEqual(
      r.outcomes.map((o) => [o.outcome, o.reason]),
      [
        ["UNAVAILABLE", "NOT_STORED_DISCOVERED"],
        ["UNAVAILABLE", "BYTES_UNAVAILABLE"],
      ]
    )
    assert.deepEqual(
      r.pdfOutcomes.map((o) => o.status),
      ["PDF_PARSE_FAILED", "PDF_PARSE_FAILED"]
    )
  })

  it("plafond 5 fichiers visuels : le 6e est « ignoré (trop gros) »", async () => {
    const files = Array.from({ length: MAX_VISUAL_FILES + 1 }, (_, i) =>
      att({ filename: `p${i}.jpg`, mimeType: "image/jpeg", bytes: buildMinimalJpeg() })
    )
    const r = await readAttachmentsForExtraction(files, VISION_ON)
    assert.equal(r.visuals.length, MAX_VISUAL_FILES)
    assert.deepEqual(r.outcomes[MAX_VISUAL_FILES], {
      filename: `p${MAX_VISUAL_FILES}.jpg`,
      kind: "image",
      outcome: "IGNORED_TOO_LARGE",
      reason: "MAX_VISUAL_FILES",
    })
  })

  it("PDF scannés prioritaires sur les photos dans le budget, ordre du message conservé", async () => {
    const files = [
      ...Array.from({ length: 5 }, (_, i) =>
        att({ filename: `p${i}.jpg`, mimeType: "image/jpeg", bytes: buildMinimalJpeg() })
      ),
      att({ filename: "bon.pdf", mimeType: "application/pdf", bytes: buildMinimalEmptyPdf() }),
    ]
    const r = await readAttachmentsForExtraction(files, VISION_ON)
    assert.equal(r.visuals.length, 5)
    assert.equal(r.outcomes[5].outcome, "READ_VISION")
    assert.equal(r.outcomes[4].outcome, "IGNORED_TOO_LARGE")
    assert.equal(r.visuals[r.visuals.length - 1].filename, "bon.pdf")
  })

  it("fichier > 5 Mo, budget total, PDF > 10 pages, image > 8000 px → ignoré (trop gros)", async () => {
    const big = buildMinimalJpeg(100, 100, 5 * 1024 * 1024 + 1)
    const four = buildMinimalJpeg(100, 100, 4 * 1024 * 1024)
    const r = await readAttachmentsForExtraction(
      [
        att({ filename: "big.jpg", mimeType: "image/jpeg", bytes: big }),
        att({ filename: "a.jpg", mimeType: "image/jpeg", bytes: four }),
        att({ filename: "b.jpg", mimeType: "image/jpeg", bytes: four }),
        att({ filename: "c.jpg", mimeType: "image/jpeg", bytes: four }),
        att({ filename: "long.pdf", mimeType: "application/pdf", bytes: buildBlankPdfWithPages(11) }),
        att({ filename: "huge.jpg", mimeType: "image/jpeg", bytes: buildMinimalJpeg(9000, 100) }),
      ],
      VISION_ON
    )
    const byName = Object.fromEntries(r.outcomes.map((o) => [o.filename, [o.outcome, o.reason]]))
    assert.deepEqual(byName["big.jpg"], ["IGNORED_TOO_LARGE", "VISUAL_FILE_BYTES"])
    assert.deepEqual(byName["a.jpg"], ["READ_VISION", undefined])
    assert.deepEqual(byName["b.jpg"], ["READ_VISION", undefined])
    assert.deepEqual(byName["c.jpg"], ["READ_VISION", undefined])
    assert.deepEqual(byName["long.pdf"], ["IGNORED_TOO_LARGE", "PDF_PAGES"])
    assert.deepEqual(byName["huge.jpg"], ["IGNORED_TOO_LARGE", "IMAGE_DIMENSIONS"])

    const budget = await readAttachmentsForExtraction(
      [1, 2, 3, 4].map((i) => att({ filename: `f${i}.jpg`, mimeType: "image/jpeg", bytes: four })),
      VISION_ON
    )
    assert.equal(budget.visuals.length, 3)
    assert.deepEqual(
      [budget.outcomes[3].outcome, budget.outcomes[3].reason],
      ["IGNORED_TOO_LARGE", "VISUAL_TOTAL_BUDGET"]
    )
  })

  it("budget texte total partagé entre pièces (24 000 caractères)", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => [`ligne ${i}`, "B".repeat(40)])
    const xlsx = await buildXlsx([{ name: "S", rows }])
    const files = [1, 2, 3, 4].map((i) => att({ filename: `t${i}.xlsx`, bytes: xlsx }))
    const r = await readAttachmentsForExtraction(files, VISION_OFF)
    const total = r.excerpts.reduce((n, e) => n + e.text.length, 0)
    assert.ok(total <= 24_000, String(total))
    assert.ok(r.excerpts.every((e) => e.text.length <= 8_000))
    assert.equal(r.outcomes[3].outcome, "READ_TEXT_TRUNCATED")
  })
})

describe("pré-sélection (avant claim)", () => {
  it("isPotentiallyReadableAttachment : STORED + format supporté ; images seulement si vision", () => {
    const base = { status: "STORED", storagePublicId: "pid" }
    assert.equal(isPotentiallyReadableAttachment({ ...base, filename: "a.pdf", mimeType: "application/pdf" }, { visionEnabled: false }), true)
    assert.equal(isPotentiallyReadableAttachment({ ...base, filename: "a.xlsx", mimeType: "application/octet-stream" }, { visionEnabled: false }), true)
    assert.equal(isPotentiallyReadableAttachment({ ...base, filename: "a.jpg", mimeType: "image/jpeg" }, { visionEnabled: false }), false)
    assert.equal(isPotentiallyReadableAttachment({ ...base, filename: "a.jpg", mimeType: "image/jpeg" }, { visionEnabled: true }), true)
    assert.equal(isPotentiallyReadableAttachment({ ...base, filename: "a.heic", mimeType: "image/heic" }, { visionEnabled: true }), false)
    assert.equal(isPotentiallyReadableAttachment({ ...base, status: "DISCOVERED", filename: "a.pdf", mimeType: "application/pdf" }, { visionEnabled: true }), false)
    assert.equal(isPotentiallyReadableAttachment({ status: "STORED", storagePublicId: null, filename: "a.pdf", mimeType: "application/pdf" }, { visionEnabled: true }), false)
  })

  it("shouldLoadAttachmentBytes : pas de chargement des images si vision OFF ni des fichiers > 10 Mo", () => {
    const base = { status: "STORED", sizeBytes: 1000 }
    assert.equal(shouldLoadAttachmentBytes({ ...base, filename: "a.jpg", mimeType: "image/jpeg" }, { visionEnabled: false }), false)
    assert.equal(shouldLoadAttachmentBytes({ ...base, filename: "a.jpg", mimeType: "image/jpeg" }, { visionEnabled: true }), true)
    assert.equal(shouldLoadAttachmentBytes({ ...base, filename: "a.pdf", mimeType: "application/pdf" }, { visionEnabled: false }), true)
    assert.equal(
      shouldLoadAttachmentBytes({ ...base, sizeBytes: 11 * 1024 * 1024, filename: "a.pdf", mimeType: "application/pdf" }, { visionEnabled: true }),
      false
    )
    assert.equal(shouldLoadAttachmentBytes({ ...base, filename: "a.heic", mimeType: "image/heic" }, { visionEnabled: true }), false)
  })
})
