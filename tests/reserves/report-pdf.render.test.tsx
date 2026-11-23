/**
 * Lot D Planificator V2 : RENDU RÉEL du PDF du procès-verbal (@react-pdf/renderer, déjà dépendance du dépôt), relu par
 * extraction de texte (unpdf). Aucune base : le PDF est construit depuis l'instantané seul.
 * Contrôles : en-tête PDF, nombre de pages, textes (numéro, chantier, réserves, empreintes), accents, dates en heure de
 * Paris, mention de signature non qualifiée, réserve de 4 000 caractères INTÉGRALEMENT restituée (aucune coupure ni
 * rognage, poursuite sur la page suivante), 60 réserves sur plusieurs pages avec pagination.
 * Déterminisme : le texte extrait de deux rendus est identique (exigé) ; l'égalité des octets est seulement CONSTATÉE et
 * consignée (diagnostic), jamais présumée.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { deflateSync } from "node:zlib"
import React from "react"
import { renderToBuffer } from "@react-pdf/renderer"
import { extractText, getDocumentProxy } from "unpdf"
import { ReceptionReportDocument } from "@/lib/reserves/report-pdf"
import { DECISION_LABEL, sha256Hex, snapshotSha256, type ReportSnapshot, type SnapshotReserve } from "@/lib/reserves/reserves.core"

// tsconfig "jsx": "preserve" → sous tsx, le JSX est compilé en React.createElement (runtime classique) — convention du dépôt.
;(globalThis as { React?: typeof React }).React = React

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

const SIGNATURE = makePng(120, 40)
const reserve = (n: number, extra: Partial<SnapshotReserve> = {}): SnapshotReserve => ({
  number: `RES-2026-${String(n).padStart(4, "0")}`, title: `Réserve n° ${n} : éclat d'enduit`, location: `Étage ${n % 4}, pièce ${n}`, severity: "MINOR", description: null, dueDate: "2026-11-20", assignee: null, ...extra,
})
const snapshot = (reserves: SnapshotReserve[]): ReportSnapshot => ({
  version: "pv-v1", number: "PV-2026-0007", company: { name: "Société Synthétique Été" }, worksite: { name: "Rénovation Hôtel Pélican", address: "12 rue des Écoles", client: "Maître d'ouvrage Béatrice" },
  decision: "WITH_RESERVES", receptionDate: "2026-11-04", signedAt: "2026-11-04T09:00:00.000Z", clientSignerName: "Béatrice Lefèvre", companySignerName: "Noël Dupré",
  attendees: "Équipe travaux, bureau d'études", remarks: "Réception prononcée sous réserve des levées ci-dessous.", reserves, signatureSha256: sha256Hex(SIGNATURE),
})
async function render(s: ReportSnapshot) {
  const buf = await renderToBuffer(React.createElement(ReceptionReportDocument, { snapshot: s, signaturePng: SIGNATURE, snapshotSha256: snapshotSha256(s) }) as Parameters<typeof renderToBuffer>[0])
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const { totalPages, text } = await extractText(pdf, { mergePages: true })
  return { buf: Buffer.from(buf), pages: totalPages, text: text.replace(/\s+/g, " ") }
}

describe("PDF du procès-verbal : rendu réel", () => {
  it("contenu : numéro, ouvrage, décision, réserves, accents, dates en heure de Paris, empreintes, mention non qualifiée", async () => {
    const s = snapshot([reserve(1, { assignee: "Plaquiste (sous-traitant)", description: "Reprise à prévoir côté fenêtre." }), reserve(2), reserve(3, { severity: "BLOCKING", dueDate: null })])
    const r = await render(s)
    assert.equal(r.buf.subarray(0, 5).toString("latin1"), "%PDF-")
    assert.equal(r.pages, 1)
    for (const t of ["Procès-verbal de réception", "PV-2026-0007", "Rénovation Hôtel Pélican", "12 rue des Écoles", "Maître d'ouvrage Béatrice", DECISION_LABEL.WITH_RESERVES,
      "Réserves (3)", "RES-2026-0001", "RES-2026-0003", "Étage 1, pièce 1", "Responsable : Plaquiste (sous-traitant)", "Bloquante", "Échéance", "20 novembre 2026",
      "réception du 04 novembre 2026", "Béatrice Lefèvre", "Noël Dupré", "04/11/2026 10:00", snapshotSha256(s), sha256Hex(SIGNATURE),
      "Ce n'est pas une signature électronique qualifiée", "Page 1 / 1"]) {
      assert.ok(r.text.includes(t), `texte attendu absent : « ${t} »`)
    }
  })
  it("réserve de 4 000 caractères : restituée en entier, dans l'ordre, sans coupure ni rognage (suite sur la page suivante)", async () => {
    const tokens: string[] = []
    let desc = "DEBUT-LONGUE"
    for (let i = 1; desc.length < 3980; i++) { const t = `m${String(i).padStart(4, "0")}`; tokens.push(t); desc += ` ${t}` }
    desc = `${desc} FIN-LONGUE`
    assert.ok(desc.length <= 4000 && desc.length > 3980, `longueur ${desc.length}`)
    const r = await render(snapshot([reserve(1), reserve(2, { description: desc }), reserve(3, { title: "Après la longue" })]))
    assert.ok(r.pages >= 2, `une description de 4 000 caractères dépasse une page (${r.pages} page(s))`)
    let from = r.text.indexOf("DEBUT-LONGUE")
    assert.ok(from >= 0, "début présent")
    for (const t of tokens) { const at = r.text.indexOf(t, from); assert.ok(at >= 0, `fragment ${t} absent ou hors ordre`); from = at }
    assert.ok(r.text.indexOf("FIN-LONGUE", from) >= 0, "fin présente")
    assert.ok(r.text.includes("Après la longue"), "la réserve suivante est rendue")
  })
  it("60 réserves : plusieurs pages, toutes présentes, pagination", async () => {
    const r = await render(snapshot(Array.from({ length: 60 }, (_, i) => reserve(i + 1, { description: `Description de la réserve ${i + 1}, détaillée sur une ligne.` }))))
    assert.ok(r.pages >= 2, `${r.pages} page(s)`)
    for (let i = 1; i <= 60; i++) assert.ok(r.text.includes(`RES-2026-${String(i).padStart(4, "0")}`), `réserve ${i}`)
    assert.ok(r.text.includes(`Page ${r.pages} / ${r.pages}`))
  })
  it("déterminisme : deux rendus du même instantané donnent le même texte ; égalité des octets constatée", async (t) => {
    const s = snapshot([reserve(1), reserve(2)])
    const [a, b] = [await render(s), await render(s)]
    assert.equal(a.text, b.text)
    assert.equal(a.pages, b.pages)
    t.diagnostic(`octets identiques entre deux rendus : ${a.buf.equals(b.buf) ? "oui" : "non"} (${a.buf.length} / ${b.buf.length} octets)`)
  })
})
