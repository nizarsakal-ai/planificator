/**
 * Document Studio — espace PDF (lots 1 et 2) : contrôles sans base. Règles pures (titre, éléments posés, police WinAnsi,
 * géométrie des pages tournées, recherche), état de l'éditeur, et aller-retour RÉEL sur des PDF construits ici avec
 * pdf-lib : lecture à l'import (pages, rotation, texte), écriture des éléments sur une copie (original intact), texte
 * posé retrouvé dans la nouvelle version, PDF chiffré refusé à l'écriture. Contrôles statiques : drapeau et accès sur la
 * route des octets, migration additive et garanties en base.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { PDFDocument, StandardFonts, degrees } from "pdf-lib"
import { extractText, getDocumentProxy } from "unpdf"
import {
  COORD_MAX, PDF_ERRORS, PDF_LIMITS, cleanOriginalName, dayText, displaySize, displayToPdf, downloadName, isValidDay, looksLikePdf,
  normalizeRotation, parseOperations, readPageGeometries, searchPages, summarizeOperations, unsupportedChars, validatePdfTitle,
  type PageGeometry,
} from "@/lib/document-studio/pdf-workspace.core"
import { moveItem, newItem, parisToday, resizeItem, toPayload } from "@/lib/document-studio/pdf-workspace.editor"
import { applyOperations, inspectPdf } from "@/lib/document-studio/pdf-workspace.pdf"
import { adresseApresSucces, retour } from "@/lib/actions/retour-action"

const read = (f: string) => readFileSync(f, "utf8")
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const ko = (r: { ok: boolean; error?: string }) => { assert.equal(r.ok, false); return r.error }

async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([595.28, 841.89])
  p1.drawText("Avis de paiement", { x: 50, y: 780, size: 16, font })
  p1.drawText("Facture 2025020 Montant 40.311,00 EUR", { x: 50, y: 740, size: 11, font })
  const p2 = doc.addPage([595.28, 841.89])
  p2.setRotation(degrees(90))
  p2.drawText("Annexe paysage", { x: 50, y: 780, size: 12, font })
  return doc.save()
}
/** PNG 1×1 opaque minimal (valide pour pdf-lib), complété jusqu'à la taille minimale exigée par l'analyseur. */
async function signaturePng(): Promise<Uint8Array> {
  // PNG 2×1 RGBA généré à la main (IHDR, IDAT zlib, IEND) : forme réelle, sans dépendance de rendu.
  const { deflateSync, crc32 } = await import("node:zlib")
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const raw = Buffer.from([0, 15, 33, 84, 255, 15, 33, 84, 255])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}
async function textOf(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  try { return (await extractText(pdf, { mergePages: false })).text } finally { await pdf.loadingTask.destroy() }
}

describe("règles pures : import", () => {
  it("signature binaire PDF reconnue dans les 1 024 premiers octets", () => {
    assert.ok(looksLikePdf(new TextEncoder().encode("%PDF-1.7\n")))
    assert.ok(looksLikePdf(new TextEncoder().encode("garbage\n%PDF-1.4")))
    assert.ok(!looksLikePdf(new TextEncoder().encode("PK\u0003\u0004 zip")))
    assert.ok(!looksLikePdf(new Uint8Array()))
  })
  it("titre : saisi, sinon nom du fichier sans extension ; borné ; contrôles retirés", () => {
    assert.equal(ok(validatePdfTitle("  Avis   GL  ", "x.pdf")), "Avis GL")
    assert.equal(ok(validatePdfTitle("", "HALL EXPO - Avis de virement.PDF")), "HALL EXPO - Avis de virement")
    assert.equal(ko(validatePdfTitle("", "a.pdf")), PDF_ERRORS.title)
    assert.equal(ok(validatePdfTitle("x".repeat(400), "a.pdf")).length, 160)
    assert.equal(cleanOriginalName("C:\\Users\\moi\\Avis.pdf"), "Avis.pdf")
    assert.equal(cleanOriginalName("../../etc/passwd"), "passwd")
    assert.equal(cleanOriginalName(""), "document.pdf")
  })
  it("nom de téléchargement ASCII sûr, suffixe de version", () => {
    assert.equal(downloadName("Avis de paiement — Hall Expo", 1), "Avis-de-paiement-Hall-Expo.pdf")
    assert.equal(downloadName("Avis", 3), "Avis-v3.pdf")
    assert.equal(downloadName("\"; rm -rf", 1), "rm-rf.pdf")
    assert.equal(downloadName("€€€", 2), "document-v2.pdf")
  })
})

describe("règles pures : géométrie des pages", () => {
  const g = (rotation: 0 | 90 | 180 | 270): PageGeometry => ({ x: 10, y: 20, width: 600, height: 800, rotation })
  it("rotation normalisée au quart de tour ; taille affichée inversée à 90° et 270°", () => {
    assert.deepEqual([0, 90, 180, 270, 360, -90, 450].map(normalizeRotation), [0, 90, 180, 270, 0, 270, 90])
    assert.deepEqual(displaySize(g(0)), { width: 600, height: 800 })
    assert.deepEqual(displaySize(g(90)), { width: 800, height: 600 })
  })
  it("coin haut-gauche affiché → coin correspondant de l'espace PDF, pour chaque rotation", () => {
    assert.deepEqual(displayToPdf(g(0), 0, 0), { x: 10, y: 820 })
    assert.deepEqual(displayToPdf(g(90), 0, 0), { x: 10, y: 20 })
    assert.deepEqual(displayToPdf(g(180), 0, 0), { x: 610, y: 20 })
    assert.deepEqual(displayToPdf(g(270), 0, 0), { x: 610, y: 820 })
    // Vers la droite à l'écran : +x PDF à 0°, +y à 90°, −x à 180°, −y à 270°.
    assert.deepEqual(displayToPdf(g(0), 5, 0), { x: 15, y: 820 })
    assert.deepEqual(displayToPdf(g(90), 5, 0), { x: 10, y: 25 })
    assert.deepEqual(displayToPdf(g(180), 5, 0), { x: 605, y: 20 })
    assert.deepEqual(displayToPdf(g(270), 5, 0), { x: 610, y: 815 })
  })
  it("géométrie stockée relue prudemment", () => {
    assert.deepEqual(readPageGeometries([{ x: 0, y: 0, width: 1, height: 2, rotation: 90 }]), [{ x: 0, y: 0, width: 1, height: 2, rotation: 90 }])
    for (const bad of [null, [], [{ x: 0, y: 0, width: 0, height: 2, rotation: 0 }], [{ x: 0, y: 0, width: 1, height: 2, rotation: 45 }], [{ x: "0", y: 0, width: 1, height: 2, rotation: 0 }]]) assert.equal(readPageGeometries(bad), null)
  })
})

describe("règles pures : éléments posés (lot 2)", () => {
  const P = (ops: unknown, pages = 2) => parseOperations(JSON.stringify(ops), pages)
  it("liste valide : texte nettoyé, date, coche, signature ; clés supplémentaires ignorées", () => {
    const v = ok(P([
      { kind: "text", page: 1, x: 100, y: 200, size: 11, text: "  Bon pour accord\u202f!  ", extra: "<script>" },
      { kind: "date", page: 1, x: 0, y: COORD_MAX, size: 10, date: "2026-11-20" },
      { kind: "check", page: 2, x: 5000, y: 5000, size: 250 },
      { kind: "signature", page: 2, x: 6000, y: 8000, width: 2200 },
    ]))
    assert.deepEqual(v[0], { kind: "text", page: 1, x: 100, y: 200, size: 11, text: "Bon pour accord\u00a0!" })
    assert.equal(summarizeOperations(v), "1 texte, 1 date, 1 coche, 1 signature")
  })
  it("refus : JSON invalide, liste vide ou trop longue, page absente, coordonnées hors page ou décimales", () => {
    assert.equal(ko(parseOperations("{", 1)), PDF_ERRORS.operations)
    assert.equal(ko(P({})), PDF_ERRORS.operations)
    assert.equal(ko(P([])), PDF_ERRORS.noOperation)
    assert.equal(ko(P(Array.from({ length: PDF_LIMITS.maxOperations + 1 }, () => ({ kind: "check", page: 1, x: 0, y: 0, size: 200 })))), PDF_ERRORS.tooManyOperations)
    assert.equal(ko(P([{ kind: "check", page: 3, x: 0, y: 0, size: 200 }])), PDF_ERRORS.page)
    assert.equal(ko(P([{ kind: "check", page: 0, x: 0, y: 0, size: 200 }])), PDF_ERRORS.operations)
    assert.equal(ko(P([{ kind: "check", page: 1, x: 10001, y: 0, size: 200 }])), PDF_ERRORS.operations)
    assert.equal(ko(P([{ kind: "check", page: 1, x: 1.5, y: 0, size: 200 }])), PDF_ERRORS.operations)
    assert.equal(ko(P([{ kind: "image", page: 1, x: 0, y: 0 }])), PDF_ERRORS.operations)
  })
  it("refus : texte vide ou trop long, taille hors bornes, date impossible, signature trop petite", () => {
    assert.equal(ko(P([{ kind: "text", page: 1, x: 0, y: 0, size: 11, text: "   " }])), PDF_ERRORS.text)
    assert.equal(ko(P([{ kind: "text", page: 1, x: 0, y: 0, size: 11, text: "x".repeat(301) }])), PDF_ERRORS.text)
    assert.equal(ko(P([{ kind: "text", page: 1, x: 0, y: 0, size: 99, text: "a" }])), PDF_ERRORS.operations)
    assert.equal(ko(P([{ kind: "date", page: 1, x: 0, y: 0, size: 10, date: "2026-02-30" }])), PDF_ERRORS.date)
    assert.equal(ko(P([{ kind: "signature", page: 1, x: 0, y: 0, width: 10 }])), PDF_ERRORS.operations)
  })
  it("police standard (WinAnsi) : accents, €, œ admis ; émoji et caractères hors jeu refusés et nommés", () => {
    assert.deepEqual(unsupportedChars("Payé 40 311,00 € — œuvre « reçue » Ÿ"), [])
    assert.deepEqual(unsupportedChars("OK ✓ 😀 ł"), ["✓", "😀", "ł"])
    assert.match(ko(P([{ kind: "text", page: 1, x: 0, y: 0, size: 11, text: "Signé ✓" }]))!, /« ✓ »/)
  })
  it("dates : calendrier réel, forme JJ/MM/AAAA", () => {
    assert.ok(isValidDay("2024-02-29") && !isValidDay("2025-02-29") && !isValidDay("20-11-2026"))
    assert.equal(dayText("2025-08-01"), "01/08/2025")
  })
})

describe("éditeur (état pur)", () => {
  it("éléments bornés à la page, tailles par paliers, liste envoyée sans textes vides", () => {
    const t = newItem("text", 1, -50, 12000, "a", "2026-11-20")
    assert.deepEqual([t.x, t.y, t.size], [0, COORD_MAX, 11])
    assert.deepEqual([moveItem(t, 5000.6, 20).x, moveItem(t, 5000.6, 20).y], [5001, 20])
    assert.equal(resizeItem(t, 1).size, 12)
    assert.equal(resizeItem({ ...t, size: 24 }, 1).size, 24)
    const s = newItem("signature", 2, 10, 10, "b", "2026-11-20")
    assert.equal(resizeItem({ ...s, width: PDF_LIMITS.maxSignatureWidth }, 1).width, PDF_LIMITS.maxSignatureWidth)
    const payload = toPayload([t, { ...t, id: "c", text: " Lu et approuvé " }, newItem("date", 1, 0, 0, "d", "2026-11-20"), s])
    assert.deepEqual(payload.map((o) => o.kind), ["text", "date", "signature"])
    assert.ok(parseOperations(JSON.stringify(payload), 2).ok, "la liste de l'éditeur passe la validation serveur")
  })
  it("date du jour à Paris", () => {
    assert.equal(parisToday(new Date("2026-11-20T23:30:00Z")), "2026-11-21")
    assert.equal(parisToday(new Date("2026-07-01T21:59:00Z")), "2026-07-01")
  })
})

describe("recherche dans les pages (lot 1)", () => {
  const pages = ["Avis de paiement N° Fournisseur 5137367", "Total : EUR 69.455,70  Échéance", ""]
  it("insensible à la casse, aux accents et aux espaces ; occurrences et extrait ; saisie trop courte ignorée", () => {
    assert.deepEqual(searchPages(pages, "AVIS").map((h) => h.page), [1])
    assert.deepEqual(searchPages(pages, "echeance").map((h) => h.page), [2])
    assert.deepEqual(searchPages(pages, "eur   69.455").map((h) => h.page), [2])
    // Tous les mots, à défaut de l'expression exacte (ponctuation entre les mots).
    assert.deepEqual(searchPages(pages, "total eur").map((h) => h.page), [2])
    assert.deepEqual(searchPages(pages, "total fournisseur"), [], "mots sur des pages différentes")
    assert.equal(searchPages(["a b a b a b"], "a b")[0].count, 3)
    assert.deepEqual(searchPages(pages, "x"), [])
    assert.deepEqual(searchPages(pages, "introuvable"), [])
    assert.match(searchPages(pages, "fournisseur")[0].snippet, /Fournisseur 5137367/)
  })
})

describe("aller-retour PDF réel (pdf-lib, unpdf)", () => {
  it("import : pages, rotation et texte lus ; fichier non PDF refusé", async () => {
    const bytes = await samplePdf()
    const info = ok(await inspectPdf(bytes))
    assert.equal(info.pageCount, 2)
    assert.deepEqual(info.pages.map((p) => p.rotation), [0, 90])
    assert.deepEqual(displaySize(info.pages[1]), { width: 841.89, height: 595.28 })
    assert.match(info.pageTexts[0], /Avis de paiement/)
    assert.deepEqual(searchPages(info.pageTexts, "2025020").map((h) => h.page), [1])
    assert.equal(info.encrypted, false)
    assert.equal(ko(await inspectPdf(new TextEncoder().encode("bonjour"))), PDF_ERRORS.notPdf)
    assert.equal(ko(await inspectPdf(new TextEncoder().encode("%PDF-1.4\ncassé"))), PDF_ERRORS.notPdf)
  })
  it("remplir et signer : copie écrite, original intact, texte posé retrouvé, page tournée prise en charge", async () => {
    const bytes = await samplePdf()
    const before = Buffer.from(bytes).toString("base64")
    const ops = ok(parseOperations(JSON.stringify([
      { kind: "text", page: 1, x: 800, y: 9000, size: 12, text: "Bon pour accord — reçu" },
      { kind: "date", page: 1, x: 800, y: 9300, size: 10, date: "2026-11-20" },
      { kind: "check", page: 1, x: 6000, y: 9000, size: 300 },
      { kind: "signature", page: 1, x: 6000, y: 9200, width: 2500 },
      { kind: "text", page: 2, x: 1000, y: 1000, size: 12, text: "Vu en paysage" },
    ]), 2))
    const out = ok(await applyOperations(bytes, ops, { png: await signaturePng() }))
    assert.equal(Buffer.from(bytes).toString("base64"), before, "octets d'entrée inchangés")
    assert.notEqual(Buffer.from(out).toString("base64"), before)
    const texts = await textOf(out)
    assert.match(texts[0], /Bon pour accord — reçu/)
    assert.match(texts[0], /20\/11\/2026/)
    assert.match(texts[0], /Avis de paiement/, "contenu d'origine conservé")
    assert.match(texts[1], /Vu en paysage/)
    const info = ok(await inspectPdf(out))
    assert.equal(info.pageCount, 2)
    assert.deepEqual(info.pages.map((p) => p.rotation), [0, 90])
  })
  it("signature posée sans tracé refusée ; PDF chiffré refusé à l'écriture", async () => {
    const bytes = await samplePdf()
    const sig = ok(parseOperations(JSON.stringify([{ kind: "signature", page: 1, x: 0, y: 0, width: 2000 }]), 2))
    assert.equal(ko(await applyOperations(bytes, sig, null)), PDF_ERRORS.signatureMissing)
    // Dictionnaire /Encrypt ajouté au trailer : pdf-lib refuse l'écriture (EncryptedPDFError) → message dédié.
    const doc = await PDFDocument.load(bytes)
    doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2, O: "x", U: "y", P: -4 })
    const enc = await doc.save()
    const check = ok(parseOperations(JSON.stringify([{ kind: "check", page: 1, x: 0, y: 0, size: 200 }]), 2))
    assert.equal(ko(await applyOperations(enc, check, null)), PDF_ERRORS.encrypted)
    assert.equal(ok(await inspectPdf(enc)).encrypted, true, "un PDF chiffré reste importable et consultable")
  })
})

describe("contrôles statiques", () => {
  it("route des octets : accès Studio (drapeau, rôle, société) avant toute lecture, empreinte revérifiée, jamais en cache", () => {
    const r = read("src/app/(dashboard)/studio-documents/fichiers/[id]/revisions/[revisionId]/route.ts")
    assert.ok(r.indexOf("const access = await resolveStudioAccess()") < r.indexOf("getRevisionBytes("))
    assert.ok(r.includes("getRevisionBytes(prisma, access.context.companyId, id, revisionId)"))
    assert.ok(r.includes("sha256Hex(r.data) !== r.sha256") && r.includes("none(409)"))
    assert.ok(r.includes(`"Cache-Control": "private, no-store"`) && r.includes(`"X-Content-Type-Options": "nosniff"`))
    const q = read("src/lib/document-studio/pdf-workspace.queries.ts")
    assert.ok(q.includes("where: { id: revisionId, pdfId, companyId }"))
    const view = q.slice(q.indexOf("export async function getStudioPdfView"), q.indexOf("export async function getRevisionBytes"))
    assert.doesNotMatch(view, /data: true/, "la fiche ne lit jamais les octets")
  })
  it("fiche PDF : garde avant lecture ; retour explicite ; « Remplir et signer » seulement sur la dernière version non chiffrée", () => {
    const c = read("src/app/(dashboard)/studio-documents/fichiers/[id]/page.tsx")
    assert.ok(c.indexOf("if (!ctx) return <AdminOnlyNotice />") < c.indexOf("getStudioPdfView("))
    assert.ok(c.includes("<ZoneRetour rendu={Date.now()}>") && c.includes("<MessageRetour><StockFlash params={sp} /></MessageRetour>"))
    assert.ok(c.includes("editable={blocked === null}"))
    assert.ok(c.includes(": v.shown.encrypted ? PDF_ERRORS.encrypted : null"))
    const w = read("src/components/document-studio/StudioPdfWorkspace.tsx")
    assert.ok(w.includes("<FormulaireRetour action={fillSignPdfAction}"))
    assert.doesNotMatch(w, /from "next\/link"|<iframe|<embed|<object|https?:\/\//)
  })
  it("retour après succès : fiche d'un PDF admise ; route des octets et « fichiers » seul jamais admis", () => {
    assert.equal(adresseApresSucces(retour(true, "PDF importé.", "/studio-documents/fichiers/abc123"), "/studio-documents"), "/studio-documents/fichiers/abc123?ok=PDF+import%C3%A9.")
    assert.equal(adresseApresSucces(retour(true, "x"), "/studio-documents/fichiers/abc123"), "/studio-documents/fichiers/abc123?ok=x")
    assert.equal(adresseApresSucces(retour(true, "x", "/studio-documents/fichiers/abc/revisions/def"), "/studio-documents"), null)
    assert.equal(adresseApresSucces(retour(true, "x", "/studio-documents/fichiers"), "/studio-documents"), null)
    assert.equal(adresseApresSucces(retour(true, "x", "/studio-documents/fichiers/../../x"), "/studio-documents"), null)
  })
  it("migration additive : deux tables, révisions immuables et numérotées sans trou, original unique par contenu", () => {
    const sql = read("prisma/migrations/20261120120000_v2_studio_pdf_workspace/migration.sql")
    assert.match(sql, /^BEGIN;$/m)
    assert.match(sql, /^COMMIT;$/m)
    for (const m of sql.matchAll(/CREATE TABLE "([a-z_]+)"/g)) assert.ok(["studio_pdfs", "studio_pdf_revisions"].includes(m[1]), m[1])
    for (const m of sql.matchAll(/ALTER TABLE "([a-z_]+)"/g)) assert.ok(["studio_pdfs", "studio_pdf_revisions"].includes(m[1]), m[1])
    assert.doesNotMatch(sql, /\bDROP\b|ALTER TYPE|ON DELETE CASCADE/)
    assert.match(sql, /CREATE UNIQUE INDEX "studio_pdf_revisions_one_original_per_content" ON "studio_pdf_revisions"\("companyId", "sha256"\) WHERE "kind" = 'ORIGINAL';/)
    assert.match(sql, /IF TG_OP <> 'INSERT' THEN\s+RAISE EXCEPTION 'studio pdf revision immutable'/)
    assert.match(sql, /"revision" = NEW\."revision" - 1/)
    assert.match(sql, /"size" = octet_length\("data"\)/)
  })
})
