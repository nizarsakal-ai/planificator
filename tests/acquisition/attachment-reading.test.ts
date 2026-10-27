/**
 * PLAN-ACQ-MULTIMODAL — Lecture des pièces jointes (texte, xlsx, vision, plafonds).
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  MAX_VISUAL_BASE64_BYTES,
  MAX_VISUAL_FILES,
  base64EncodedLength,
  isPotentiallyReadableAttachment,
  planAttachmentLoads,
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

  it("limite 5 Mo appliquée au base64 : une photo de 4,2 Mo (≈ 5,6 Mo encodés) est ignorée (trop gros)", async () => {
    const raw42 = buildMinimalJpeg(100, 100, Math.round(4.2 * 1024 * 1024))
    assert.ok(base64EncodedLength(raw42.byteLength) > MAX_VISUAL_BASE64_BYTES)
    const okRaw = buildMinimalJpeg(100, 100, 3_932_160) // ceil(n/3)*4 = 5 242 880 pile
    assert.equal(base64EncodedLength(okRaw.byteLength), MAX_VISUAL_BASE64_BYTES)
    const pdf42 = Buffer.concat([buildMinimalEmptyPdf(), Buffer.alloc(Math.round(4.2 * 1024 * 1024))])
    const r = await readAttachmentsForExtraction(
      [
        att({ id: "p1", filename: "photo-4,2Mo.jpg", mimeType: "image/jpeg", bytes: raw42 }),
        att({ id: "p2", filename: "limite.jpg", mimeType: "image/jpeg", bytes: okRaw }),
        att({ id: "p3", filename: "scan-4,2Mo.pdf", mimeType: "application/pdf", bytes: pdf42 }),
      ],
      VISION_ON
    )
    assert.deepEqual(
      r.outcomes.map((o) => [o.attachmentId, o.outcome, o.reason]),
      [
        ["p1", "IGNORED_TOO_LARGE", "VISUAL_FILE_BYTES"],
        ["p2", "READ_VISION", undefined],
        ["p3", "IGNORED_TOO_LARGE", "VISUAL_FILE_BYTES"],
      ]
    )
    assert.ok(r.visuals.every((v) => v.base64.length <= MAX_VISUAL_BASE64_BYTES))
  })

  it("budget total encodé, PDF > 10 pages, image > 8000 px → ignoré (trop gros)", async () => {
    const three5 = buildMinimalJpeg(100, 100, 3_500_000)
    const r = await readAttachmentsForExtraction(
      [
        att({ filename: "long.pdf", mimeType: "application/pdf", bytes: buildBlankPdfWithPages(11) }),
        att({ filename: "huge.jpg", mimeType: "image/jpeg", bytes: buildMinimalJpeg(9000, 100) }),
      ],
      VISION_ON
    )
    const byName = Object.fromEntries(r.outcomes.map((o) => [o.filename, [o.outcome, o.reason]]))
    assert.deepEqual(byName["long.pdf"], ["IGNORED_TOO_LARGE", "PDF_PAGES"])
    assert.deepEqual(byName["huge.jpg"], ["IGNORED_TOO_LARGE", "IMAGE_DIMENSIONS"])

    const budget = await readAttachmentsForExtraction(
      [1, 2, 3, 4, 5].map((i) => att({ filename: `f${i}.jpg`, mimeType: "image/jpeg", bytes: three5 })),
      VISION_ON
    )
    assert.equal(budget.visuals.length, 4)
    assert.ok(budget.visuals.reduce((n, v) => n + v.base64.length, 0) <= 20 * 1024 * 1024)
    assert.deepEqual(
      [budget.outcomes[4].outcome, budget.outcomes[4].reason],
      ["IGNORED_TOO_LARGE", "VISUAL_TOTAL_BUDGET"]
    )
  })

  it("homonymes : chaque issue porte l'id de sa pièce", async () => {
    const r = await readAttachmentsForExtraction(
      [
        att({ id: "a", filename: "plan.pdf", mimeType: "application/pdf", bytes: buildMinimalTextPdf("Plan A") }),
        att({ id: "b", filename: "plan.pdf", mimeType: "application/pdf", bytes: Buffer.from("%PDF-1.4 corrompu") }),
      ],
      VISION_OFF
    )
    assert.deepEqual(
      r.outcomes.map((o) => [o.attachmentId, o.outcome]),
      [
        ["a", "READ_TEXT"],
        ["b", "FAILED"],
      ]
    )
    assert.deepEqual(
      r.pdfOutcomes.map((o) => [o.attachmentId, o.status]),
      [
        ["a", "PDF_TEXT_EXTRACTED"],
        ["b", "PDF_PARSE_FAILED"],
      ]
    )
  })

  it("xlsx désactivé (flag lecture PJ OFF) → IGNORED_FORMAT XLSX_FLAG_OFF, non lu", async () => {
    const xlsx = await buildXlsx([{ name: "S", rows: [["a", "b"]] }])
    const r = await readAttachmentsForExtraction([att({ filename: "t.xlsx", bytes: xlsx })], {
      ...VISION_OFF,
      xlsxEnabled: false,
    })
    assert.equal(r.excerpts.length, 0)
    assert.deepEqual(r.outcomes[0], { filename: "t.xlsx", kind: "xlsx", outcome: "IGNORED_FORMAT", reason: "XLSX_FLAG_OFF" })
  })

  it("échéance dépassée → pièces restantes FAILED (DEADLINE), aucune lecture", async () => {
    // 1re pièce : contrôle d'échéance + budget PDF à t=1000 ; ensuite t=2000 (> échéance).
    const times = [1_000, 1_000]
    const r = await readAttachmentsForExtraction(
      [
        att({ filename: "a.pdf", mimeType: "application/pdf", bytes: buildMinimalTextPdf("A") }),
        att({ filename: "b.pdf", mimeType: "application/pdf", bytes: buildMinimalTextPdf("B") }),
      ],
      { ...VISION_OFF, deadlineAt: 1_500, now: () => times.shift() ?? 2_000 }
    )
    assert.deepEqual(
      r.outcomes.map((o) => [o.filename, o.outcome, o.reason]),
      [
        ["a.pdf", "READ_TEXT", undefined],
        ["b.pdf", "FAILED", "DEADLINE"],
      ]
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

describe("planAttachmentLoads — bornes mémoire", () => {
  it("≤ 10 candidats visuels chargés, ≤ 60 Mo déclarés ; hors budget → IGNORED_TOO_LARGE (LOAD_BUDGET)", async () => {
    const metas = [
      ...Array.from({ length: 12 }, (_, i) => ({ filename: `p${i}.jpg`, mimeType: "image/jpeg", status: "STORED", sizeBytes: 1000 })),
      { filename: "a.pdf", mimeType: "application/pdf", status: "STORED", sizeBytes: 9 * 1024 * 1024 },
    ]
    const plan = planAttachmentLoads(metas, { visionEnabled: true })
    assert.deepEqual(plan.slice(0, 10), Array(10).fill("LOAD"))
    assert.deepEqual(plan.slice(10, 12), ["BUDGET", "BUDGET"])
    assert.equal(plan[12], "LOAD")
    assert.deepEqual(planAttachmentLoads(metas, { visionEnabled: false }).slice(0, 12), Array(12).fill("SKIP"))

    const many = Array.from({ length: 8 }, (_, i) => ({ filename: `b${i}.pdf`, mimeType: "application/pdf", status: "STORED", sizeBytes: 9 * 1024 * 1024 }))
    const p2 = planAttachmentLoads(many, { visionEnabled: false })
    assert.equal(p2.filter((x) => x === "LOAD").length, 6)
    assert.equal(p2[6], "BUDGET")

    const r = await readAttachmentsForExtraction(
      [{ filename: "b6.pdf", mimeType: "application/pdf", category: "PLAN", sizeBytes: 9, status: "STORED", bytes: null, loadSkippedForBudget: true }],
      { vision: { enabled: true } }
    )
    assert.deepEqual(r.outcomes[0], { filename: "b6.pdf", kind: "pdf", outcome: "IGNORED_TOO_LARGE", reason: "LOAD_BUDGET" })
  })
})
