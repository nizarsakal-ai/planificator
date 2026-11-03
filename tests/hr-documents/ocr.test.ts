/**
 * PLV2-DOC-RH-002 — lecture locale : couche texte, OCR réel sur scans et photos, statuts distincts.
 * Pièces entièrement synthétiques (tests/hr-documents/ocr/fixtures.ts) ; aucune donnée réelle.
 */
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import sharp from "sharp"
import { OcrEngineMissing, readDocument, shutdownOcr, type OcrEngine } from "../../src/lib/hr-documents/recognition/ocr"
import { recognize } from "../../src/lib/hr-documents/recognition/engine"
import { buildMinimalTextPdf } from "../../src/lib/acquisition/extraction/pdf-text-extract"
import { buildFixtures, jpegPdf, td3, type Fixture } from "./ocr/fixtures"

const NOW = new Date("2026-11-03T12:00:00Z")
const MRZ = td3("UTO", { last: "EXEMPLE", first: ["LEA"], birth: "1991-04-02", sex: "F", nat: "UTO", expiry: "2030-01-31", number: "AB1234567" }).join("\n")
const fake = (page: string, confidence = 85, mrz = ""): (() => Promise<OcrEngine>) => async () => ({
  recognize: async (_png, mode) => ({ text: mode === "page" ? page : mrz, confidence: mode === "page" ? confidence : 80 }),
})
async function photo() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560"><rect width="100%" height="100%" fill="#eef"/><text x="40" y="80" font-size="40">PASSEPORT</text></svg>`
  return sharp(Buffer.from(svg)).jpeg().toBuffer({ resolveWithObject: true })
}

describe("statuts de lecture : jamais « illisible » sans vraie tentative OCR", () => {
  it("PDF avec couche texte : lu sans OCR (le moteur n'est même pas chargé)", async () => {
    const r = await readDocument(buildMinimalTextPdf("BULLETIN DE PAIE Periode du 01/10/2026 au 31/10/2026 Net a payer 1 000,00 EUR"), "pdf",
      { engine: async () => { throw new Error("ne doit pas être appelé") } })
    assert.equal(r.status, "TEXT_LAYER"); assert.equal(r.rotation, null)
  })
  it("scan PDF sans couche texte : l'image de la page est extraite puis lue par OCR", async () => {
    const { data, info } = await photo()
    const r = await readDocument(jpegPdf(data, info.width, info.height), "pdf", { engine: fake("PASSEPORT / PASSPORT\nNom / Surname\nEXEMPLE", 88, MRZ) })
    assert.equal(r.status, "OCR"); assert.equal(r.mrzFound, true); assert.match(r.text, /EXEMPLE/)
    const p = recognize({ text: r.text, fileName: "Scan.pdf", employees: [], now: NOW, reading: r })
    assert.equal(p.category!.value, "PASSPORT"); assert.equal(p.identity!.mrzChecksValid, true); assert.equal(p.identity!.birthDate!.value, "1991-04-02")
  })
  it("moteur absent : ENGINE_MISSING, distinct d'un échec ou d'un contenu illisible", async () => {
    const { data } = await photo()
    const r = await readDocument(new Uint8Array(data), "jpeg", { engine: async () => { throw new OcrEngineMissing() } })
    assert.equal(r.status, "ENGINE_MISSING"); assert.equal(r.text, "")
  })
  it("échec technique : erreur du moteur, délai dépassé, image non décodable, page vectorielle — chacun avec son motif", async () => {
    const { data } = await photo()
    const broken = await readDocument(new Uint8Array(data), "jpeg", { engine: async () => ({ recognize: async () => { throw new Error("wasm") } }) })
    assert.deepEqual([broken.status, broken.reason], ["TECHNICAL_FAILURE", "OCR_ERROR"])
    const slow = await readDocument(new Uint8Array(data), "jpeg", { engine: fake("PASSEPORT EXEMPLE"), timeoutMs: -1 })
    assert.deepEqual([slow.status, slow.reason], ["TECHNICAL_FAILURE", "TIMEOUT"])
    const garbage = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])
    const undecodable = await readDocument(garbage, "jpeg", { engine: fake("x") })
    assert.deepEqual([undecodable.status, undecodable.reason], ["TECHNICAL_FAILURE", "IMAGE_NOT_DECODABLE"])
    const vector = await readDocument(buildMinimalTextPdf(""), "pdf", { engine: fake("x") })
    assert.deepEqual([vector.status, vector.reason], ["TECHNICAL_FAILURE", "PAGE_RENDER_UNAVAILABLE"])
  })
  it("contenu illisible : seulement après une passe OCR qui ne rend presque rien ; aucun texte parasite transmis", async () => {
    const { data } = await photo()
    const r = await readDocument(new Uint8Array(data), "jpeg", { engine: fake("~ . ,", 14) })
    assert.equal(r.status, "UNREADABLE"); assert.equal(r.text, ""); assert.ok(r.confidence !== null)
  })
  it("orientation bornée : au plus 4 orientations sondées, puis une passe complète", async () => {
    const { data } = await photo()
    let page = 0
    await readDocument(new Uint8Array(data), "jpeg", { engine: async () => ({ recognize: async (_p, mode) => { if (mode === "page") page++; return { text: "", confidence: 5 } } }) })
    assert.ok(page <= 6, `passes texte : ${page}`)
  })
})

describe("OCR réel (Tesseract local, modèles du paquet) sur pièces synthétiques", () => {
  let fixtures: Fixture[]
  before(async () => { fixtures = await buildFixtures() })
  after(() => shutdownOcr())
  it("passeport photographié : MRZ contrôlée, champs lus, en moins de 20 s", { timeout: 120_000 }, async () => {
    const f = fixtures.find((x) => x.name === "Passeport — photo JPEG")!
    const r = await readDocument(f.bytes, f.kind)
    assert.equal(r.status, "OCR"); assert.ok(r.durationMs < 20_000)
    const p = recognize({ text: r.text, fileName: f.fileName, employees: [], now: NOW, reading: r })
    assert.equal(p.category!.value, "PASSPORT"); assert.equal(p.identity!.mrzChecksValid, true)
    assert.equal(p.identity!.lastName!.value, f.expected.lastName); assert.equal(p.identity!.expiryDate!.value, f.expected.expiryDate)
  })
  it("photo floue : OCR tenté puis « illisible », jamais un champ inventé", { timeout: 120_000 }, async () => {
    const f = fixtures.find((x) => x.name.startsWith("Photo floue"))!
    const r = await readDocument(f.bytes, f.kind)
    assert.equal(r.status, "UNREADABLE")
    const p = recognize({ text: r.text, fileName: f.fileName, employees: [], now: NOW, reading: r })
    assert.equal(p.identity, null); assert.equal(p.category, null)
  })
})
