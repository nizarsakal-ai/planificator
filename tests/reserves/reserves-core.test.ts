/** Lot D Planificator V2 : règles pures des réserves et du procès-verbal (validation, preuves, signature, instantané). */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { deflateSync } from "node:zlib"
import {
  MAX_LISTED_RESERVES, MAX_REPORT_RESERVES, RESERVE_ERRORS, canonicalJson, documentNumber, parseSignature, planCancel, planFile, planLift, planReport, safeFileName,
  isStructurallyValidPng, sha256Hex, sniffMime, snapshotSha256, sortReserves, validateReserve, type ReportSnapshot,
} from "@/lib/reserves/reserves.core"

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (size: number) => { const b = Buffer.alloc(size, 7); Buffer.from(PNG_HEAD).copy(b); return b }
const TODAY = new Date("2026-11-04T00:00:00Z")
/** Bloc PNG (longueur, type, données, CRC) construit sans dépendance. */
function pngChunk(type: string, body: Buffer): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const tb = Buffer.concat([Buffer.from(type, "latin1"), body])
  let c = 0xffffffff; for (const v of tb) c = table[(c ^ v) & 0xff] ^ (c >>> 8)
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0)
  return Buffer.concat([len, tb, crc])
}
/** PNG RÉEL et décodable au profil d'un canevas (RVBA 8 bits par défaut, non entrelacé), motif peu compressible ;
 * `colorType` et `extra` (blocs insérés avant IDAT) servent aux cas refusés. */
function makePng(width = 40, height = 20, colorType = 6, extra: Buffer[] = []): Buffer {
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1, row = 1 + width * bpp
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType
  const raw = Buffer.alloc(height * row)
  for (let y = 0; y < height; y++) for (let x = 0; x < width * bpp; x++) raw[y * row + 1 + x] = (((x * 73856093) ^ (y * 19349663)) >>> 0) & 0xff
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), ...extra, pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))])
}

describe("réserves", () => {
  it("validation : intitulé, localisation, gravité, description", () => {
    assert.deepEqual(validateReserve({ title: "  Éclat d'enduit ", location: " R+1 chambre 2 ", severity: "MAJOR" }), { ok: true, value: { title: "Éclat d'enduit", location: "R+1 chambre 2", description: null, severity: "MAJOR", dueDate: null, assigneeLabel: null } })
    assert.deepEqual(validateReserve({ title: "ab", location: "x", severity: "MINOR" }), { ok: false, error: RESERVE_ERRORS.title })
    assert.deepEqual(validateReserve({ title: "abc", location: " ", severity: "MINOR" }), { ok: false, error: RESERVE_ERRORS.location })
    assert.deepEqual(validateReserve({ title: "abc", location: "x", severity: "GRAVE" }), { ok: false, error: RESERVE_ERRORS.severity })
    assert.deepEqual(validateReserve({ title: "abc", location: "x", severity: "MINOR", description: "d".repeat(4001) }), { ok: false, error: RESERVE_ERRORS.description })
  })
  it("responsable : libellé libre facultatif, nettoyé, 120 caractères au plus (aucun identifiant de salarié)", () => {
    const ok = validateReserve({ title: "abc", location: "x", severity: "MINOR", assigneeLabel: "  Plaquiste (sous-traitant)  " })
    assert.equal(ok.ok && ok.value.assigneeLabel, "Plaquiste (sous-traitant)")
    const blank = validateReserve({ title: "abc", location: "x", severity: "MINOR", assigneeLabel: "   " })
    assert.equal(blank.ok && blank.value.assigneeLabel, null)
    assert.equal(validateReserve({ title: "abc", location: "x", severity: "MINOR", assigneeLabel: "é".repeat(120) }).ok, true)
    assert.deepEqual(validateReserve({ title: "abc", location: "x", severity: "MINOR", assigneeLabel: "é".repeat(121) }), { ok: false, error: RESERVE_ERRORS.assignee })
  })
  it("levée : seulement ouverte, note obligatoire ; annulation : ouverte, non inscrite à un PV, motif obligatoire", () => {
    assert.deepEqual(planLift("OPEN", " Reprise faite "), { ok: true, value: { note: "Reprise faite" } })
    assert.deepEqual(planLift("LIFTED", "Reprise faite"), { ok: false, error: RESERVE_ERRORS.notOpen })
    assert.deepEqual(planLift("OPEN", "ok"), { ok: false, error: RESERVE_ERRORS.note })
    assert.deepEqual(planCancel("OPEN", false, "Doublon"), { ok: true, value: { reason: "Doublon" } })
    assert.deepEqual(planCancel("OPEN", true, "Doublon"), { ok: false, error: RESERVE_ERRORS.listedInReport })
    assert.deepEqual(planCancel("CANCELLED", false, "Doublon"), { ok: false, error: RESERVE_ERRORS.notOpen })
    assert.deepEqual(planCancel("OPEN", false, "x"), { ok: false, error: RESERVE_ERRORS.reason })
  })
})

describe("preuves et signature", () => {
  it("type réel par signature binaire, jamais par le nom ; taille bornée", () => {
    assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg")
    assert.equal(sniffMime(png(16)), "image/png")
    assert.equal(sniffMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp")
    assert.equal(sniffMime(Buffer.from("%PDF-1.7\n")), "application/pdf")
    assert.equal(sniffMime(Buffer.from("<svg onload=alert(1)>")), null)
    assert.equal(sniffMime(Buffer.from("<html>")), null)
    assert.deepEqual(planFile("photo.jpg", Buffer.from("<svg>")), { ok: false, error: RESERVE_ERRORS.file }, "extension menteuse refusée")
    assert.deepEqual(planFile("vide.png", new Uint8Array(0)), { ok: false, error: RESERVE_ERRORS.file })
    assert.deepEqual(planFile("gros.png", png(5_000_001)), { ok: false, error: RESERVE_ERRORS.file })
    const ok = planFile("C:\\Users\\x\\IMG_1.png", png(64))
    assert.ok(ok.ok)
    if (ok.ok) assert.deepEqual([ok.value.mime, ok.value.size, ok.value.originalName, ok.value.sha256.length], ["image/png", 64, "IMG_1.png", 64])
    assert.equal(safeFileName('../../a"b\u0007.pdf'), "ab.pdf")
    assert.equal(safeFileName("///"), "preuve")
  })
  it("signature : URL de données PNG réellement décodable seulement, taille bornée, empreinte des octets", () => {
    const real = makePng()
    assert.ok(real.length >= 100, `PNG de test assez grand pour la borne basse (${real.length} octets)`)
    const s = parseSignature(`data:image/png;base64,${real.toString("base64")}`)
    assert.ok(s.ok)
    if (s.ok) assert.equal(s.value.sha256, sha256Hex(real))
    for (const bad of ["", "data:image/jpeg;base64,AAAA", `data:image/png;base64,${png(50).toString("base64")}`, `data:image/png;base64,${png(500).toString("base64")}`, `data:image/png;base64,${Buffer.alloc(500).toString("base64")}`, `data:image/png;base64,${png(300_001).toString("base64")}`, "javascript:alert(1)"]) {
      assert.deepEqual(parseSignature(bad), { ok: false, error: RESERVE_ERRORS.signature }, bad.slice(0, 30))
    }
  })
  it("signature : en-tête PNG correct mais fichier tronqué, CRC faux, octets après IEND ou données incohérentes ⇒ refus propre", () => {
    const real = makePng()
    assert.equal(isStructurallyValidPng(real), true)
    const sig = (b: Buffer) => parseSignature(`data:image/png;base64,${b.toString("base64")}`)
    const truncated = real.subarray(0, real.length - 20)
    assert.equal(truncated.subarray(0, 8).equals(real.subarray(0, 8)), true, "magic intact")
    assert.deepEqual(sig(truncated), { ok: false, error: RESERVE_ERRORS.signature }, "tronqué")
    const badCrc = Buffer.from(real); badCrc[8 + 8 + 13] ^= 0xff // CRC de l'IHDR
    assert.deepEqual(sig(badCrc), { ok: false, error: RESERVE_ERRORS.signature }, "CRC faux")
    assert.deepEqual(sig(Buffer.concat([real, Buffer.from("xx")])), { ok: false, error: RESERVE_ERRORS.signature }, "octets après IEND")
    const wrongSize = makePng(40, 20); wrongSize.writeUInt32BE(21, 8 + 8 + 4) // hauteur annoncée ≠ données
    assert.equal(isStructurallyValidPng(wrongSize), false, "hauteur incohérente (CRC IHDR faux et taille décompressée)")
    assert.equal(isStructurallyValidPng(makePng(4001, 1)), false, "dimension au-delà de 4 000")
    assert.equal(isStructurallyValidPng(png(500)), false, "seul l'en-tête est PNG")
    assert.equal(isStructurallyValidPng(makePng(600, 160)), true, "format d'un canevas de signature (RVBA 8 bits, 600 × 160) accepté")
    assert.equal(isStructurallyValidPng(makePng(600, 160, 2)), true, "RVB 8 bits accepté")
    assert.equal(isStructurallyValidPng(makePng(2100, 2000)), false, "taille décompressée 16,8 Mo > 16 Mo refusée avant décompression")
  })
  it("signature : profil canevas seulement (revue indépendante D) ; blocs critiques inconnus ou palette refusés, auxiliaires admis", () => {
    assert.equal(isStructurallyValidPng(makePng(40, 20, 0)), false, "niveaux de gris : hors profil canevas")
    assert.equal(isStructurallyValidPng(makePng(40, 20, 3)), false, "palette (type 3, sans PLTE) : refusée")
    assert.equal(isStructurallyValidPng(makePng(40, 20, 3, [pngChunk("PLTE", Buffer.alloc(3))])), false, "palette avec PLTE : refusée aussi")
    assert.equal(isStructurallyValidPng(makePng(40, 20, 6, [pngChunk("ABCD", Buffer.alloc(4))])), false, "bloc critique inconnu refusé")
    assert.equal(isStructurallyValidPng(makePng(40, 20, 6, [pngChunk("PLTE", Buffer.alloc(3))])), false, "PLTE refusé dans le profil retenu")
    assert.equal(isStructurallyValidPng(makePng(40, 20, 6, [pngChunk("sRGB", Buffer.from([0])), pngChunk("tEXt", Buffer.from("Software\0canvas", "latin1"))])), true, "blocs auxiliaires d'un canevas admis")
    assert.equal(isStructurallyValidPng(makePng(40, 20, 6, [pngChunk("a\u0001bc", Buffer.alloc(1))])), false, "type de bloc non alphabétique refusé")
  })
})

describe("procès-verbal", () => {
  const base = { decision: "WITH_RESERVES", receptionDate: TODAY, clientSignerName: "M. Client", companySignerName: "Mme Conductrice" }
  it("décision cohérente avec les réserves ouvertes", () => {
    assert.equal(planReport(base, 2, TODAY).ok, true)
    assert.deepEqual(planReport(base, 0, TODAY), { ok: false, error: RESERVE_ERRORS.withReservesButNone })
    assert.deepEqual(planReport({ ...base, decision: "WITHOUT_RESERVES" }, 1, TODAY), { ok: false, error: RESERVE_ERRORS.withoutReservesButOpen })
    assert.equal(planReport({ ...base, decision: "WITHOUT_RESERVES" }, 0, TODAY).ok, true)
    assert.equal(planReport({ ...base, decision: "REFUSED" }, 0, TODAY).ok, true)
    assert.equal(planReport({ ...base, decision: "REFUSED" }, 3, TODAY).ok, true)
    assert.deepEqual(planReport({ ...base, decision: "OK" }, 1, TODAY), { ok: false, error: RESERVE_ERRORS.decision })
  })
  it("plafond : jusqu'à 500 réserves ouvertes admises ; au-delà, refus explicite (jamais de troncature), quelle que soit la décision", () => {
    assert.equal(MAX_REPORT_RESERVES, 500)
    assert.equal(MAX_LISTED_RESERVES, 500)
    assert.equal(planReport(base, 500, TODAY).ok, true)
    for (const decision of ["WITH_RESERVES", "REFUSED", "WITHOUT_RESERVES"]) {
      assert.deepEqual(planReport({ ...base, decision }, 501, TODAY), { ok: false, error: RESERVE_ERRORS.tooManyReserves }, decision)
    }
    assert.match(RESERVE_ERRORS.tooManyReserves, /500/)
  })
  it("date ni future ni trop ancienne ; signataires et textes bornés", () => {
    assert.deepEqual(planReport({ ...base, receptionDate: new Date("2026-11-05T00:00:00Z") }, 1, TODAY), { ok: false, error: RESERVE_ERRORS.receptionDate })
    assert.deepEqual(planReport({ ...base, receptionDate: new Date("2015-01-01T00:00:00Z") }, 1, TODAY), { ok: false, error: RESERVE_ERRORS.receptionDate })
    assert.deepEqual(planReport({ ...base, receptionDate: null }, 1, TODAY), { ok: false, error: RESERVE_ERRORS.receptionDate })
    assert.deepEqual(planReport({ ...base, clientSignerName: "X" }, 1, TODAY), { ok: false, error: RESERVE_ERRORS.signer })
    assert.deepEqual(planReport({ ...base, remarks: "r".repeat(4001) }, 1, TODAY), { ok: false, error: RESERVE_ERRORS.remarks })
  })
  it("instantané canonique : même empreinte quel que soit l'ordre des clés ; tout changement la modifie", () => {
    const snap: ReportSnapshot = {
      version: "pv-v1", number: "PV-2026-0001", company: { name: "Entreprise" }, worksite: { name: "Chantier", address: null, client: "Client" },
      decision: "WITH_RESERVES", receptionDate: "2026-11-04", signedAt: "2026-11-04T09:00:00.000Z", clientSignerName: "M. Client", companySignerName: "Mme C",
      attendees: null, remarks: null, reserves: [{ number: "RES-2026-0002", title: "B", location: "L", severity: "MINOR", description: null, dueDate: null, assignee: null }], signatureSha256: "a".repeat(64),
    }
    const shuffled = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(snap).reverse()))) as ReportSnapshot
    assert.equal(snapshotSha256(shuffled), snapshotSha256(snap))
    assert.equal(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] }), '{"a":[2,{"c":"x","d":null}],"b":1}')
    assert.notEqual(snapshotSha256({ ...snap, decision: "REFUSED" }), snapshotSha256(snap))
    assert.throws(() => canonicalJson({ x: Number.NaN }), RangeError)
    assert.throws(() => canonicalJson({ x: 1.5 }), RangeError, "décimal refusé : jsonb le normaliserait")
    assert.throws(() => canonicalJson({ x: undefined }), TypeError)
  })
  it("réserves triées par numéro ; numérotation", () => {
    const r = (number: string) => ({ number, title: "t", location: "l", severity: "MINOR" as const, description: null, dueDate: null, assignee: null })
    assert.deepEqual(sortReserves([r("RES-2026-0010"), r("RES-2026-0002")]).map((x) => x.number), ["RES-2026-0002", "RES-2026-0010"])
    assert.equal(documentNumber("PV", 2026, 7), "PV-2026-0007")
  })
})
