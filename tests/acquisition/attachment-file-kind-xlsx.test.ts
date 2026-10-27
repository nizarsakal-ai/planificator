/**
 * PLAN-ACQ-MULTIMODAL — Détection de type (signature magique) + lecteur .xlsx.
 */
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test"

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  guessAttachmentKindFromMeta,
  readImageDimensions,
  sniffAttachmentKind,
} from "@/lib/acquisition/extraction/attachment-file-kind"
import {
  cellValueToText,
  extractXlsxText,
  zipDeclaredUncompressedBytes,
} from "@/lib/acquisition/extraction/xlsx-text-extract"
import { buildMinimalTextPdf, countPdfPages } from "@/lib/acquisition/extraction/pdf-text-extract"
import {
  buildMinimalHeic,
  buildMinimalJpeg,
  buildMinimalPng,
  buildXlsx,
} from "./helpers/multimodal-fixtures"

describe("attachment-file-kind — signature magique", () => {
  it("JPEG déclaré application/octet-stream → image/jpeg", () => {
    const k = sniffAttachmentKind(buildMinimalJpeg(), {
      filename: "IMG_2635.jpeg",
      mimeType: "application/octet-stream",
    })
    assert.deepEqual(k, { kind: "image", mediaType: "image/jpeg" })
  })

  it("le MIME déclaré ne fait pas foi (PNG déclaré pdf → image/png)", () => {
    const k = sniffAttachmentKind(buildMinimalPng(), { filename: "x.pdf", mimeType: "application/pdf" })
    assert.deepEqual(k, { kind: "image", mediaType: "image/png" })
  })

  it("HEIC détecté par ftyp", () => {
    assert.deepEqual(
      sniffAttachmentKind(buildMinimalHeic(), { filename: "IMG_1.HEIC", mimeType: "image/heic" }),
      { kind: "heic" }
    )
  })

  it("PDF / ZIP .xlsx / ZIP non tableur / .xlsm", async () => {
    assert.deepEqual(
      sniffAttachmentKind(buildMinimalTextPdf("x"), { filename: "a.bin", mimeType: "x" }),
      { kind: "pdf" }
    )
    const xlsx = await buildXlsx([{ name: "S", rows: [["a"]] }])
    assert.deepEqual(sniffAttachmentKind(xlsx, { filename: "t.xlsx", mimeType: "application/octet-stream" }), {
      kind: "xlsx",
    })
    assert.deepEqual(sniffAttachmentKind(xlsx, { filename: "t.zip", mimeType: "application/zip" }), {
      kind: "unsupported",
    })
    assert.deepEqual(sniffAttachmentKind(xlsx, { filename: "t.xlsm", mimeType: "application/zip" }), {
      kind: "unsupported",
    })
  })

  it("métadonnées seules : pdf, xlsx, heic, image, autre", () => {
    assert.equal(guessAttachmentKindFromMeta({ filename: "BC.PDF", mimeType: "" }).kind, "pdf")
    assert.equal(
      guessAttachmentKindFromMeta({ filename: "TEMPLATE_CROQUIS.xlsx", mimeType: "application/octet-stream" }).kind,
      "xlsx"
    )
    assert.equal(guessAttachmentKindFromMeta({ filename: "a.heif", mimeType: "" }).kind, "heic")
    assert.equal(guessAttachmentKindFromMeta({ filename: "a.jpeg", mimeType: "application/octet-stream" }).kind, "image")
    assert.equal(guessAttachmentKindFromMeta({ filename: "a.dwg", mimeType: "application/octet-stream" }).kind, "unsupported")
  })

  it("dimensions JPEG / PNG", () => {
    assert.deepEqual(readImageDimensions(buildMinimalJpeg(1234, 567), "image/jpeg"), { width: 1234, height: 567 })
    assert.deepEqual(readImageDimensions(buildMinimalPng(10, 20), "image/png"), { width: 10, height: 20 })
    assert.equal(readImageDimensions(Buffer.from([0xff, 0xd8]), "image/jpeg"), null)
  })

  it("countPdfPages : PDF valide = 1, invalide = null", async () => {
    assert.equal(await countPdfPages(buildMinimalTextPdf("Bon de commande")), 1)
    assert.equal(await countPdfPages(Buffer.from("not a pdf")), null)
  })
})

describe("xlsx-text-extract (exceljs)", () => {
  it("classeur valide relu sans dépendre du timing du flux ZIP", async () => {
    const buf = await buildXlsx([
      { name: "Première", rows: [["Client", "ACME"], ["Adresse", "12 rue des Lilas"]] },
      { name: "Vide", rows: [] },
      { name: "Dernière", rows: [["Début", new Date("2026-11-02T00:00:00Z")], ["Montant", { formula: "1+1", result: 2 }]] },
    ])
    for (let i = 0; i < 3; i++) {
      const r = await extractXlsxText(buf)
      assert.equal(r.status, "XLSX_TEXT_EXTRACTED")
      assert.match(r.text, /Feuille: Première/)
      assert.match(r.text, /Client \| ACME/)
      assert.match(r.text, /Début \| 2026-11-02/)
      assert.match(r.text, /Montant \| 2/)
      assert.doesNotMatch(r.text, /1\+1/)
    }
  })

  it("échéance pendant le chargement : worker arrêté et échec borné", async () => {
    const buf = await buildXlsx([{ name: "Test", rows: [["Client", "ACME"]] }])
    const started = Date.now()
    const r = await extractXlsxText(buf, { timeoutMs: 1 })
    assert.equal(r.status, "XLSX_PARSE_FAILED")
    assert.ok(Date.now() - started < 2_000)
  })

  it("feuille par feuille, cellules séparées par ' | '", async () => {
    const buf = await buildXlsx([
      { name: "Croquis", rows: [["Client", "ACME BTP"], ["Adresse", "12 rue des Lilas", "75011 Paris"]] },
      { name: "Vide", rows: [] },
      { name: "Dates", rows: [["Début", new Date("2026-03-02T00:00:00Z")]] },
    ])
    const r = await extractXlsxText(buf)
    assert.equal(r.status, "XLSX_TEXT_EXTRACTED")
    assert.equal(
      r.text,
      [
        "--- Feuille: Croquis ---",
        "Client | ACME BTP",
        "Adresse | 12 rue des Lilas | 75011 Paris",
        "--- Feuille: Dates ---",
        "Début | 2026-03-02",
      ].join("\n")
    )
  })

  it("formules : seul le résultat en cache est repris, jamais évalué", async () => {
    const buf = await buildXlsx([
      {
        name: "F",
        rows: [
          ["Total", { formula: "SUM(1,2)", result: 3 }],
          ["Sans cache", { formula: "1+1" }],
          ["Erreur", { formula: "1/0", result: { error: "#DIV/0!" } }],
        ],
      },
    ])
    const r = await extractXlsxText(buf)
    assert.equal(r.status, "XLSX_TEXT_EXTRACTED")
    assert.match(r.text, /Total \| 3/)
    assert.doesNotMatch(r.text, /SUM|1\+1|#DIV/)
    assert.match(r.text, /^Sans cache$/m)
  })

  it("cellValueToText : richText, hyperlink, booléen, objet inconnu", () => {
    assert.equal(cellValueToText({ richText: [{ text: "a" }, { text: "b" }] }), "ab")
    assert.equal(cellValueToText({ text: "lien", hyperlink: "https://x" }), "lien")
    assert.equal(cellValueToText(true), "VRAI")
    assert.equal(cellValueToText({ error: "#N/A" }), "")
  })

  it("fichier corrompu → XLSX_PARSE_FAILED sans exception", async () => {
    const r1 = await extractXlsxText(Buffer.from("PK\x03\x04 garbage garbage"))
    assert.equal(r1.status, "XLSX_PARSE_FAILED")
    const r2 = await extractXlsxText(Buffer.from("pas un zip"))
    assert.equal(r2.status, "XLSX_PARSE_FAILED")
    const good = await buildXlsx([{ name: "S", rows: [["a", "b"]] }])
    const truncated = good.subarray(0, Math.floor(good.length / 2))
    assert.equal((await extractXlsxText(truncated)).status, "XLSX_PARSE_FAILED")
  })

  it("trop gros (taille fichier ou taille décompressée déclarée) → XLSX_TOO_LARGE", async () => {
    const buf = await buildXlsx([{ name: "S", rows: [["a", "b"]] }])
    assert.equal((await extractXlsxText(buf, { maxBytes: 100 })).status, "XLSX_TOO_LARGE")
    const declared = zipDeclaredUncompressedBytes(buf)
    assert.ok(declared && declared > 0)
    assert.equal(
      (await extractXlsxText(buf, { maxUncompressedBytes: declared! - 1 })).status,
      "XLSX_TOO_LARGE"
    )
  })

  it("plafonds feuilles / lignes / caractères → XLSX_TEXT_TRUNCATED", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`ligne ${i}`, "x".repeat(40)])
    const buf = await buildXlsx([
      { name: "A", rows },
      { name: "B", rows: [["b"]] },
      { name: "C", rows: [["c"]] },
    ])
    const bySheets = await extractXlsxText(buf, { maxSheets: 1 })
    assert.equal(bySheets.status, "XLSX_TEXT_TRUNCATED")
    assert.doesNotMatch(bySheets.text, /Feuille: B/)
    const byRows = await extractXlsxText(buf, { maxRowsPerSheet: 5 })
    assert.equal(byRows.status, "XLSX_TEXT_TRUNCATED")
    assert.doesNotMatch(byRows.text, /ligne 5\b/)
    const byChars = await extractXlsxText(buf, { maxChars: 200 })
    assert.equal(byChars.status, "XLSX_TEXT_TRUNCATED")
    assert.ok(byChars.text.length <= 200)
  })

  it("classeur sans valeur → XLSX_EMPTY", async () => {
    const buf = await buildXlsx([{ name: "S", rows: [] }])
    assert.equal((await extractXlsxText(buf)).status, "XLSX_EMPTY")
  })
})
