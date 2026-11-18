import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { prepareUpload, SHRINK_STEPS } from "../../src/components/hr-documents/upload-prepare"
import { MAX_UPLOAD_BYTES, tooLargeMessage } from "../../src/lib/hr-documents/upload-limit"

// Données synthétiques. Incident 18/11 : PDF de 5,3 Mo refusé par l'hébergeur (limite 4,5 Mo), affiché « illisible ».
const file = (name: string, type: string, size: number) => new File([new Uint8Array(size)], name, { type })
const limit = 1000

describe("préparation d'un fichier avant envoi", () => {
  it("la limite d'envoi reste sous celle de l'hébergeur (4,5 Mo) avec la marge multipart", () => {
    assert.ok(MAX_UPLOAD_BYTES <= 4.5 * 1000 * 1000 - 200 * 1024)
  })
  it("sous la limite : fichier envoyé tel quel, sans réencodage", async () => {
    let calls = 0
    const r = await prepareUpload(file("a.pdf", "application/pdf", 900), async () => { calls++; return null }, limit)
    assert.equal(r.ok && r.reduced, false); assert.equal(calls, 0)
  })
  it("PDF trop lourd : refusé avant envoi avec la taille et la marche à suivre, jamais réécrit", async () => {
    let calls = 0
    const r = await prepareUpload(file("Caces.pdf", "application/pdf", 5000), async () => { calls++; return new Blob([new Uint8Array(10)]) }, limit)
    assert.equal(r.ok, false); assert.equal(calls, 0)
    if (!r.ok) { assert.match(r.error, /Caces\.pdf/); assert.match(r.error, /4 Mo au maximum/); assert.match(r.error, /Réduire la taille du fichier/) }
  })
  it("photo trop lourde : réduite en JPEG au premier palier qui passe sous la limite", async () => {
    const seen: number[] = []
    const r = await prepareUpload(file("photo.HEIC", "image/heic", 5000), async (_f, side) => { seen.push(side); return new Blob([new Uint8Array(side === SHRINK_STEPS[1].longSide ? 800 : 1200)]) }, limit)
    assert.ok(r.ok && r.reduced); assert.deepEqual(seen, [SHRINK_STEPS[0].longSide, SHRINK_STEPS[1].longSide])
    if (r.ok) { assert.equal(r.file.name, "photo.jpg"); assert.equal(r.file.type, "image/jpeg"); assert.equal(r.file.size, 800) }
  })
  it("photo indécodable par le navigateur ou toujours trop lourde : refus explicite", async () => {
    assert.equal((await prepareUpload(file("x.heic", "", 5000), async () => null, limit)).ok, false)
    assert.equal((await prepareUpload(file("x.jpg", "image/jpeg", 5000), async () => new Blob([new Uint8Array(2000)]), limit)).ok, false)
  })
  it("message lisible en français", () => {
    assert.match(tooLargeMessage("doc.pdf", 5.3 * 1024 * 1024), /5,3 Mo/)
  })
})
