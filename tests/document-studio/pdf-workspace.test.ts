/**
 * Document Studio — espace PDF (lots 1 à 3) : contrôles sans base. Lot 3 : plan de pages (ordre, rotation, retrait),
 * liste de PDF à combiner, assemblage réel (organiser, extraire, combiner) et garanties de la migration. Lot 4 :
 * annotations (surligner, encadrer, note) et biffage réel (page remplacée par son image, texte d'origine introuvable). Règles pures (titre, éléments posés, police WinAnsi,
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
  COORD_MAX, MIN_RECT, PDF_ERRORS, PDF_LIMITS, addRotation, imageFitsPage, parseRedactions, summarizeRedactions, cleanOriginalName, isIdentityPlan, pageRanges, parseCombineIds, parsePagePlan, readSources, summarizePlan, dayText, displaySize, displayToPdf, downloadName, isValidDay, looksLikePdf,
  normalizeRotation, parseOperations, readPageGeometries, searchPages, summarizeOperations, unsupportedChars, validatePdfTitle,
  type PageGeometry,
} from "@/lib/document-studio/pdf-workspace.core"
import { moveItem, newItem, parisToday, rectFromCorners, resizeItem, toPayload } from "@/lib/document-studio/pdf-workspace.editor"
import { applyOperations, assemblePdf, inspectPdf, parseJpegDataUrl, redactPdf } from "@/lib/document-studio/pdf-workspace.pdf"
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

describe("lot 3 : organiser, extraire, combiner (règles pures)", () => {
  it("plan de pages : ordre, rotation ajoutée, retrait ; doublons, pages absentes et rotations libres refusés", () => {
    assert.deepEqual(ok(parsePagePlan(JSON.stringify([{ page: 3, rotate: 90 }, { page: 1, rotate: 0, x: "ignoré" }]), 3)), [{ page: 3, rotate: 90 }, { page: 1, rotate: 0 }])
    assert.equal(ko(parsePagePlan("[]", 3)), PDF_ERRORS.planEmpty)
    for (const bad of ["{", "{}", JSON.stringify([{ page: 1, rotate: 0 }, { page: 1, rotate: 90 }]), JSON.stringify([{ page: 4, rotate: 0 }]),
      JSON.stringify([{ page: 1, rotate: 45 }]), JSON.stringify([{ page: 1.5, rotate: 0 }]), JSON.stringify([1, 2])]) assert.equal(ko(parsePagePlan(bad, 3)), PDF_ERRORS.plan, bad)
  })
  it("plan identique, résumé lisible, rotation résultante, plages de pages", () => {
    assert.ok(isIdentityPlan([{ page: 1, rotate: 0 }, { page: 2, rotate: 0 }], 2))
    assert.ok(!isIdentityPlan([{ page: 2, rotate: 0 }, { page: 1, rotate: 0 }], 2))
    assert.ok(!isIdentityPlan([{ page: 1, rotate: 90 }, { page: 2, rotate: 0 }], 2))
    assert.ok(!isIdentityPlan([{ page: 1, rotate: 0 }], 2))
    assert.equal(summarizePlan([{ page: 3, rotate: 90 }, { page: 1, rotate: 0 }], 4), "pages réordonnées, 1 page pivotée, 2 pages retirées")
    assert.deepEqual([addRotation(270, 90), addRotation(0, -90), addRotation(90, 180)], [0, 270, 270])
    assert.equal(pageRanges([1, 2, 3, 5, 7, 8]), "1-3, 5, 7-8")
    assert.equal(pageRanges([3, 2, 1]), "3, 2, 1")
  })
  it("liste à combiner : 2 à 20 identifiants sûrs, sans doublon ; sources stockées relues prudemment", () => {
    assert.deepEqual(ok(parseCombineIds(JSON.stringify(["a1", "b_2"]))), ["a1", "b_2"])
    for (const bad of ["[]", JSON.stringify(["a"]), JSON.stringify(Array.from({ length: 21 }, (_, i) => `p${i}`)), JSON.stringify(["a", "../b"]), "x"]) assert.equal(ko(parseCombineIds(bad)), PDF_ERRORS.combineParts, bad)
    assert.equal(ko(parseCombineIds(JSON.stringify(["a", "a"]))), PDF_ERRORS.combineDuplicate)
    assert.deepEqual(readSources([{ pdfId: "a", revisionId: "r", revision: 1, title: "T", pages: [1] }, { pdfId: 3 }, null]), [{ pdfId: "a", revisionId: "r", revision: 1, title: "T", pages: [1] }])
  })
  it("taille stockée bornée sous la limite de réponse Vercel (4,5 Mo) : tout PDF enregistré reste téléchargeable", () => {
    assert.ok(PDF_LIMITS.maxStoredBytes < 4.5 * 1024 * 1024)
    assert.ok(PDF_LIMITS.maxUploadBytes <= PDF_LIMITS.maxStoredBytes)
  })
})

describe("lot 3 : assemblage réel (pdf-lib)", () => {
  it("organiser : ordre, rotation ajoutée à l'existante, page retirée ; originaux intacts", async () => {
    const bytes = await samplePdf()
    const before = Buffer.from(bytes).toString("base64")
    const out = ok(await assemblePdf([{ bytes, pages: [{ page: 2, rotate: 90 }, { page: 1, rotate: 270 }] }], { title: "Réorganisé" }))
    assert.equal(Buffer.from(bytes).toString("base64"), before)
    const info = ok(await inspectPdf(out))
    assert.equal(info.pageCount, 2)
    assert.deepEqual(info.pages.map((p) => p.rotation), [180, 270], "page 2 (déjà à 90°) + 90° ; page 1 + 270°")
    assert.match(info.pageTexts[0], /Annexe paysage/)
    assert.match(info.pageTexts[1], /Avis de paiement/)
    const single = ok(await inspectPdf(ok(await assemblePdf([{ bytes, pages: [{ page: 1, rotate: 0 }] }], { title: "Extrait" }))))
    assert.equal(single.pageCount, 1)
  })
  it("combiner : pages de plusieurs PDF dans l'ordre des parties ; refus : page absente, aucune page, source chiffrée", async () => {
    const a = await samplePdf()
    const b = await PDFDocument.create()
    b.addPage([300, 300]).drawText("Second document", { x: 20, y: 150, size: 12, font: await b.embedFont(StandardFonts.Helvetica) })
    const bBytes = await b.save()
    const out = ok(await assemblePdf([{ bytes: bBytes, pages: [{ page: 1, rotate: 0 }] }, { bytes: a, pages: [{ page: 1, rotate: 0 }, { page: 2, rotate: 0 }] }], { title: "Dossier" }))
    const texts = await textOf(out)
    assert.equal(texts.length, 3)
    assert.match(texts[0], /Second document/)
    assert.match(texts[1], /Avis de paiement/)
    assert.equal((await PDFDocument.load(out)).getTitle(), "Dossier")
    assert.equal(ko(await assemblePdf([{ bytes: a, pages: [{ page: 3, rotate: 0 }] }], { title: "x" })), PDF_ERRORS.page)
    assert.equal(ko(await assemblePdf([{ bytes: a, pages: [] }], { title: "x" })), PDF_ERRORS.planEmpty)
    const doc = await PDFDocument.load(a)
    doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2, O: "x", U: "y", P: -4 })
    assert.equal(ko(await assemblePdf([{ bytes: await doc.save(), pages: [{ page: 1, rotate: 0 }] }], { title: "x" })), PDF_ERRORS.sourceEncrypted)
  })
  it("migration : révision réorganisée sans signataire, origine et sources cohérentes et figées", () => {
    const sql = read("prisma/migrations/20261120120000_v2_studio_pdf_workspace/migration.sql")
    assert.match(sql, /CREATE TYPE "StudioPdfRevisionKind" AS ENUM \('ORIGINAL', 'FILLED', 'ORGANIZED'\);/)
    assert.match(sql, /CREATE TYPE "StudioPdfOrigin" AS ENUM \('IMPORTED', 'COMBINED', 'EXTRACTED'\);/)
    assert.match(sql, /AND \("kind" <> 'ORGANIZED' OR "signerName" IS NULL\)/)
    assert.match(sql, /\("origin" = 'IMPORTED' AND "sources" IS NULL\)/)
    assert.match(sql, /NEW\."origin", NEW\."sources"/)
  })
})

/** JPEG synthétique : marqueurs SOI, SOF0 (dimensions, 3 composantes), SOS, données de remplissage, EOI. pdf-lib n'en lit
 * que les dimensions (aucun décodage) ; suffisant pour vérifier la construction de la page biffée. */
function fakeJpeg(width: number, height: number, pad = 1500): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]
  return new Uint8Array([0xff, 0xd8, ...sof, ...sos, ...new Array(pad).fill(0x55), 0xff, 0xd9])
}
const jpegUrl = (b: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(b).toString("base64")}`

describe("lot 4 : annoter (règles et rendu)", () => {
  const P = (ops: unknown) => parseOperations(JSON.stringify(ops), 2)
  it("surligner, encadrer : rectangle dans la page, côté minimal ; note : texte WinAnsi borné", () => {
    const v = ok(P([
      { kind: "highlight", page: 1, x: 100, y: 200, w: 3000, h: 300 },
      { kind: "box", page: 2, x: 9000, y: 9000, w: 1000, h: 1000 },
      { kind: "note", page: 1, x: 500, y: 500, size: 10, text: " À vérifier " },
    ]))
    assert.deepEqual(v[2], { kind: "note", page: 1, x: 500, y: 500, size: 10, text: "À vérifier" })
    assert.equal(summarizeOperations(v), "1 surlignage, 1 cadre, 1 note")
    assert.equal(ko(P([{ kind: "box", page: 1, x: 9500, y: 0, w: 600, h: 100 }])), PDF_ERRORS.operations, "déborde à droite")
    assert.equal(ko(P([{ kind: "highlight", page: 1, x: 0, y: 0, w: MIN_RECT - 1, h: 100 }])), PDF_ERRORS.operations, "trop étroit")
    assert.match(ko(P([{ kind: "note", page: 1, x: 0, y: 0, size: 10, text: "OK ✓" }]))!, /« ✓ »/)
  })
  it("rendu réel : note écrite (texte extractible), surlignage et cadre dessinés, page tournée comprise", async () => {
    const bytes = await samplePdf()
    const ops = ok(P([
      { kind: "highlight", page: 1, x: 700, y: 600, w: 4000, h: 300 },
      { kind: "box", page: 1, x: 600, y: 1100, w: 6000, h: 500 },
      { kind: "note", page: 1, x: 600, y: 2000, size: 11, text: "Paiement reçu le 05/08" },
      { kind: "note", page: 2, x: 1000, y: 1000, size: 11, text: "Annexe vue" },
    ]))
    const out = ok(await applyOperations(bytes, ops, null))
    const texts = await textOf(out)
    assert.match(texts[0], /Paiement reçu le 05\/08/)
    assert.match(texts[1], /Annexe vue/)
    assert.match(texts[0], /Avis de paiement/, "surlignage par-dessus : texte d'origine toujours lisible")
  })
  it("éditeur : rectangle depuis deux coins (tout sens), borné ; déplacement qui reste dans la page ; note envoyée", () => {
    assert.deepEqual(rectFromCorners(5000, 6000, 4000, 5500), { x: 4000, y: 5500, w: 1000, h: 500 })
    assert.deepEqual(rectFromCorners(9800, 0, 12000, 400), { x: 9800, y: 0, w: 200, h: 400 })
    assert.equal(rectFromCorners(100, 100, 120, 900), null, "trop étroit : simple clic ignoré")
    const box = { ...newItem("box", 1, 0, 0, "b", "2026-11-20"), w: 2000, h: 1000 }
    assert.deepEqual([moveItem(box, 9500, 9800).x, moveItem(box, 9500, 9800).y], [8000, 9000])
    const note = { ...newItem("note", 1, 10, 10, "n", "2026-11-20"), text: " Vu " }
    assert.deepEqual(toPayload([box, note, { ...note, id: "vide", text: " " }]).map((o) => o.kind), ["box", "note"])
    assert.ok(parseOperations(JSON.stringify(toPayload([box, note])), 1).ok)
  })
})

describe("lot 4 : biffer", () => {
  it("zones : par page une fois, dans la page, côté minimal, bornes de pages et de zones ; triées par page", () => {
    const v = ok(parseRedactions(JSON.stringify([{ page: 2, rects: [{ x: 0, y: 0, w: 100, h: 100 }] }, { page: 1, rects: [{ x: 10, y: 10, w: 500, h: 60, z: 1 }] }]), 2))
    assert.deepEqual(v.map((r) => r.page), [1, 2])
    assert.deepEqual(v[0].rects[0], { x: 10, y: 10, w: 500, h: 60 })
    assert.equal(summarizeRedactions(v), "2 zones biffées sur 2 pages (pages 1-2)")
    assert.equal(ko(parseRedactions("[]", 2)), PDF_ERRORS.redactEmpty)
    for (const bad of [
      [{ page: 1, rects: [] }], [{ page: 3, rects: [{ x: 0, y: 0, w: 100, h: 100 }] }],
      [{ page: 1, rects: [{ x: 0, y: 0, w: 100, h: 100 }] }, { page: 1, rects: [{ x: 0, y: 0, w: 100, h: 100 }] }],
      [{ page: 1, rects: [{ x: 9990, y: 0, w: 100, h: 100 }] }], [{ page: 1, rects: [{ x: 0, y: 0, w: 10, h: 100 }] }],
    ]) assert.equal(ko(parseRedactions(JSON.stringify(bad), 2)), PDF_ERRORS.redactions, JSON.stringify(bad))
    const many = Array.from({ length: PDF_LIMITS.maxRedactPages + 1 }, (_, i) => ({ page: i + 1, rects: [{ x: 0, y: 0, w: 100, h: 100 }] }))
    assert.equal(ko(parseRedactions(JSON.stringify(many), 20)), PDF_ERRORS.redactTooManyPages)
  })
  it("image : JPEG vérifié (signature, poids) ; proportion de la page à 2 % près et définition minimale", () => {
    assert.ok(parseJpegDataUrl(jpegUrl(fakeJpeg(1700, 2404))))
    assert.equal(parseJpegDataUrl(`data:image/png;base64,${Buffer.from(fakeJpeg(10, 10)).toString("base64")}`), null)
    assert.equal(parseJpegDataUrl(`data:image/jpeg;base64,${Buffer.alloc(2000, 1).toString("base64")}`), null, "pas un JPEG")
    assert.equal(parseJpegDataUrl(jpegUrl(fakeJpeg(10, 10, 10))), null, "trop petit")
    assert.equal(parseJpegDataUrl(jpegUrl(fakeJpeg(10, 10, PDF_LIMITS.maxRedactImageBytes))), null, "trop lourd")
    const a4 = { width: 595.28, height: 841.89 }
    assert.ok(imageFitsPage({ width: 1700, height: 2404 }, a4))
    assert.ok(!imageFitsPage({ width: 1700, height: 1700 }, a4), "proportion différente")
    assert.ok(!imageFitsPage({ width: 600, height: 849 }, a4), "définition insuffisante")
  })
  it("page biffée remplacée par son image seule : texte d'origine introuvable, autres pages intactes, page tournée prise en compte", async () => {
    const bytes = await samplePdf()
    const red = ok(parseRedactions(JSON.stringify([{ page: 1, rects: [{ x: 500, y: 500, w: 5000, h: 800 }] }, { page: 2, rects: [{ x: 0, y: 0, w: 100, h: 100 }] }]), 2))
    const images = new Map([[1, fakeJpeg(1700, 2404)], [2, fakeJpeg(1700, 1202)]])
    const out = ok(await redactPdf(bytes, red, images, { title: "Biffé" }))
    const texts = await textOf(out)
    assert.equal(texts[0].trim(), "", "plus aucun texte extractible sur la page biffée")
    assert.equal(texts[1].trim(), "")
    assert.ok(!Buffer.from(out).toString("latin1").includes("Avis de paiement"))
    const info = ok(await inspectPdf(out))
    assert.equal(info.pageCount, 2)
    assert.deepEqual(info.pages.map((p) => p.rotation), [0, 0], "rotation déjà appliquée dans l'image")
    assert.deepEqual(displaySize(info.pages[1]), { width: 841.89, height: 595.28 }, "page tournée : taille affichée conservée")
    // Une seule page biffée : l'autre est copiée telle quelle.
    const one = ok(await redactPdf(bytes, [red[0]], new Map([[1, fakeJpeg(1700, 2404)]]), { title: "x" }))
    const t2 = await textOf(one)
    assert.equal(t2[0].trim(), "")
    assert.match(t2[1], /Annexe paysage/)
  })
  it("refus : image manquante ou en trop, proportion fausse, PDF chiffré", async () => {
    const bytes = await samplePdf()
    const red = ok(parseRedactions(JSON.stringify([{ page: 1, rects: [{ x: 0, y: 0, w: 100, h: 100 }] }]), 2))
    assert.equal(ko(await redactPdf(bytes, red, new Map(), { title: "x" })), PDF_ERRORS.redactImages)
    assert.equal(ko(await redactPdf(bytes, red, new Map([[1, fakeJpeg(1700, 2404)], [2, fakeJpeg(1700, 1202)]]), { title: "x" })), PDF_ERRORS.redactImages)
    assert.equal(ko(await redactPdf(bytes, red, new Map([[1, fakeJpeg(1700, 1700)]]), { title: "x" })), PDF_ERRORS.redactImages)
    const doc = await PDFDocument.load(bytes)
    doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2, O: "x", U: "y", P: -4 })
    assert.equal(ko(await redactPdf(await doc.save(), red, new Map([[1, fakeJpeg(1700, 2404)]]), { title: "x" })), PDF_ERRORS.encrypted)
  })
  it("requête d'enregistrement sous la limite Vercel ; migrations : valeur ajoutée seule, puis contrainte qui l'emploie", () => {
    assert.ok(Math.ceil(PDF_LIMITS.maxRedactImagesBytes * 4 / 3) < 4.5 * 1024 * 1024 * 0.9, "images en base64 + champs < 4,5 Mo")
    const kind = read("prisma/migrations/20261120160000_v2_studio_pdf_redacted_kind/migration.sql")
    assert.match(kind, /ALTER TYPE "StudioPdfRevisionKind" ADD VALUE IF NOT EXISTS 'REDACTED';/)
    assert.doesNotMatch(kind.replace(/^--.*$/gm, ""), /CHECK|CREATE|DROP/)
    const check = read("prisma/migrations/20261120160100_v2_studio_pdf_redacted_check/migration.sql")
    assert.match(check, /DROP CONSTRAINT "studio_pdf_revisions_shape_check";/)
    assert.match(check, /"kind" IN \('FILLED', 'ORGANIZED', 'REDACTED'\)/)
    assert.match(check, /\("kind" NOT IN \('ORGANIZED', 'REDACTED'\) OR "signerName" IS NULL\)/)
    for (const m of check.matchAll(/ALTER TABLE "([a-z_]+)"/g)) assert.equal(m[1], "studio_pdf_revisions")
  })
})
