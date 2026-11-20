/**
 * Document Studio — espace PDF (lots 1 à 3) sur une base PostgreSQL JETABLE : import (empreinte, géométrie, texte),
 * original déjà importé rouvert, remplir et signer (nouvelle version, original intact, signataire et empreintes), version
 * périmée refusée, enregistrements concurrents (un seul gagne), isolation entre entreprises, journal, et garanties de la
 * base (révisions immuables, jamais supprimées, numérotation sans trou, original unique par contenu). Lot 3 : organiser
 * (nouvelle version, plan empreint), extraire et combiner (nouveau PDF, sources figées), refus et isolation.
 * Exécution : TEST_PG_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   sh tests/billing/pg/with-disposable-db.sh studio_pdf npm run test:studio-pdf:pg
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { deflateSync, crc32 } from "node:zlib"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { PDFDocument, StandardFonts } from "pdf-lib"
import * as svc from "@/lib/document-studio/pdf-workspace.service"
import { getRevisionBytes, getStudioPdfView, listStudioPdfs } from "@/lib/document-studio/pdf-workspace.queries"
import { PDF_ERRORS } from "@/lib/document-studio/pdf-workspace.core"

const db = new PrismaClient()
const A = { companyId: "coA", userId: "uA" }
const A2 = { companyId: "coA", userId: "uA2" }
const B = { companyId: "coB", userId: "uB" }
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { assert.ok(r.ok, r.ok ? "" : r.error); return (r as { ok: true; value: T }).value }
const ko = (r: { ok: boolean; error?: string }) => { assert.equal(r.ok, false); return r.error }

async function pdf(label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([595.28, 841.89]).drawText(`Avis de paiement ${label}`, { x: 50, y: 780, size: 14, font })
  doc.addPage([595.28, 841.89]).drawText("Page deux", { x: 50, y: 780, size: 14, font })
  return doc.save()
}
function signatureDataUrl(): string {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const w = 40, h = 10
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const rows = Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, (_, x) => [15, 33, 84, (x + y) % 3 ? 255 : 0]).flat())])))
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))])
  assert.ok(png.length >= 100, "PNG assez grand pour l'analyseur")
  return `data:image/png;base64,${png.toString("base64")}`
}
const OPS = JSON.stringify([
  { kind: "text", page: 1, x: 800, y: 9000, size: 12, text: "Bon pour accord" },
  { kind: "date", page: 1, x: 800, y: 9300, size: 10, date: "2026-11-20" },
  { kind: "signature", page: 2, x: 6000, y: 8500, width: 2400 },
])
let original: Uint8Array
let pdfId = "", rev1 = ""

before(async () => {
  for (const sqlText of [
    `INSERT INTO companies(id,name,slug,"updatedAt") VALUES ('coA','BTP A','a',now()),('coB','BTP B','b',now())`,
    `INSERT INTO users(id,email,password,"updatedAt") VALUES ('uA','a@x.test','x',now()),('uA2','a2@x.test','x',now()),('uB','b@x.test','x',now())`,
  ]) await db.$executeRawUnsafe(sqlText)
  original = await pdf("A")
})
after(() => db.$disconnect())

describe("import (lot 1)", () => {
  it("révision 1 : octets, empreinte, pages et texte ; journal ; fiche sans octets", async () => {
    const r = ok(await svc.importPdf(db, A, { title: "", originalName: "HALL EXPO - Avis.pdf", bytes: original }))
    assert.equal(r.duplicate, false)
    pdfId = r.pdfId
    const v = await getStudioPdfView(db, A.companyId, pdfId, null)
    assert.ok(v)
    assert.equal(v!.title, "HALL EXPO - Avis")
    assert.equal(v!.revisions.length, 1)
    assert.equal(v!.shown.kind, "ORIGINAL")
    assert.equal(v!.shown.sha256, sha(original))
    assert.equal(v!.pages.length, 2)
    assert.match(v!.pageTexts[0], /Avis de paiement A/)
    rev1 = v!.shown.id
    const bytes = await getRevisionBytes(db, A.companyId, pdfId, rev1)
    assert.equal(Buffer.compare(bytes!.data, Buffer.from(original)), 0)
    const log = await db.historyLog.findFirst({ where: { companyId: "coA", entityType: "StudioPdf", entityId: pdfId } })
    assert.match(log!.detail!, /importé \(2 pages\)/)
  })
  it("même original réimporté : fiche existante rouverte, rien de dupliqué ; autre entreprise : import distinct", async () => {
    const again = ok(await svc.importPdf(db, A2, { title: "Autre titre", originalName: "copie.pdf", bytes: original }))
    assert.deepEqual(again, { pdfId, duplicate: true })
    assert.equal(await db.studioPdf.count({ where: { companyId: "coA" } }), 1)
    const b = ok(await svc.importPdf(db, B, { title: "Avis B", originalName: "b.pdf", bytes: original }))
    assert.equal(b.duplicate, false)
    assert.notEqual(b.pdfId, pdfId)
  })
  it("refus : fichier vide, non PDF, trop lourd", async () => {
    assert.equal(ko(await svc.importPdf(db, A, { title: "x y z", originalName: "a.pdf", bytes: new Uint8Array() })), PDF_ERRORS.noFile)
    assert.equal(ko(await svc.importPdf(db, A, { title: "x y z", originalName: "a.pdf", bytes: new TextEncoder().encode("bonjour") })), PDF_ERRORS.notPdf)
    assert.equal(ko(await svc.importPdf(db, A, { title: "x y z", originalName: "a.pdf", bytes: new Uint8Array(4 * 1024 * 1024 + 1) })), PDF_ERRORS.tooLarge)
  })
  it("isolation : une autre entreprise ne voit ni la fiche ni les octets", async () => {
    assert.equal(await getStudioPdfView(db, "coB", pdfId, null), null)
    assert.equal(await getRevisionBytes(db, "coB", pdfId, rev1), null)
    assert.ok((await listStudioPdfs(db, "coB")).every((p) => p.id !== pdfId))
  })
})

describe("remplir et signer (lot 2)", () => {
  let rev2 = ""
  it("version 2 : écrite depuis la dernière, signataire et empreintes ; original intact", async () => {
    const r = ok(await svc.fillAndSignPdf(db, A2, pdfId, { baseRevisionId: rev1, operations: OPS, signerName: "Marie Durand", signature: signatureDataUrl() }))
    assert.equal(r.revision, 2)
    rev2 = r.revisionId
    const row = await db.studioPdfRevision.findUnique({ where: { id: rev2 } })
    assert.equal(row!.kind, "FILLED")
    assert.equal(row!.signerName, "Marie Durand")
    assert.match(row!.signatureSha256!, /^[0-9a-f]{64}$/)
    assert.match(row!.operationsSha256!, /^[0-9a-f]{64}$/)
    assert.equal(row!.sha256, sha(row!.data))
    assert.match((row!.pageTexts as string[])[0], /Bon pour accord/)
    const first = await getRevisionBytes(db, A.companyId, pdfId, rev1)
    assert.equal(Buffer.compare(first!.data, Buffer.from(original)), 0, "original intact")
    const v = await getStudioPdfView(db, A.companyId, pdfId, null)
    assert.equal(v!.latest.revision, 2)
    assert.equal((await getStudioPdfView(db, A.companyId, pdfId, 1))!.shown.revision, 1, "ancienne version consultable")
    const log = await db.historyLog.findFirst({ where: { entityId: pdfId, action: "UPDATED" } })
    assert.match(log!.detail!, /version 2 enregistrée \(1 texte, 1 date, 1 signature\), signée par Marie Durand/)
  })
  it("refus : version périmée, signature posée sans tracé ni nom, tracé non posé, autre entreprise", async () => {
    assert.equal(ko(await svc.fillAndSignPdf(db, A, pdfId, { baseRevisionId: rev1, operations: OPS, signerName: "X Y", signature: signatureDataUrl() })), PDF_ERRORS.notLatest)
    assert.equal(ko(await svc.fillAndSignPdf(db, A, pdfId, { baseRevisionId: rev2, operations: OPS, signerName: "Marie", signature: "" })), PDF_ERRORS.signatureMissing)
    assert.ok(ko(await svc.fillAndSignPdf(db, A, pdfId, { baseRevisionId: rev2, operations: OPS, signerName: "", signature: signatureDataUrl() }))!.includes("signataire"))
    const textOnly = JSON.stringify([{ kind: "text", page: 1, x: 0, y: 0, size: 10, text: "Vu" }])
    assert.equal(ko(await svc.fillAndSignPdf(db, A, pdfId, { baseRevisionId: rev2, operations: textOnly, signerName: "", signature: signatureDataUrl() })), PDF_ERRORS.signatureUnused)
    assert.equal(ko(await svc.fillAndSignPdf(db, B, pdfId, { baseRevisionId: rev2, operations: textOnly, signerName: null, signature: null })), PDF_ERRORS.notFound)
    assert.equal(await db.studioPdfRevision.count({ where: { pdfId } }), 2, "aucune version créée par un refus")
  })
  it("deux enregistrements concurrents depuis la même version : un seul gagne", async () => {
    const textOnly = (t: string) => JSON.stringify([{ kind: "text", page: 1, x: 100, y: 100, size: 10, text: t }])
    const [r1, r2] = await Promise.all([
      svc.fillAndSignPdf(db, A, pdfId, { baseRevisionId: rev2, operations: textOnly("Premier"), signerName: null, signature: null }),
      svc.fillAndSignPdf(db, A2, pdfId, { baseRevisionId: rev2, operations: textOnly("Second"), signerName: null, signature: null }),
    ])
    assert.equal([r1, r2].filter((r) => r.ok).length, 1)
    assert.equal(([r1, r2].find((r) => !r.ok) as { error: string }).error, PDF_ERRORS.notLatest)
    assert.deepEqual((await db.studioPdfRevision.findMany({ where: { pdfId }, orderBy: { revision: "asc" }, select: { revision: true } })).map((r) => r.revision), [1, 2, 3])
  })
})

describe("garanties de la base", () => {
  it("révision ni modifiée, ni supprimée ; PDF jamais supprimé ; tables non vidables", async () => {
    await assert.rejects(db.studioPdfRevision.update({ where: { id: rev1 }, data: { signerName: "Pirate" } }), /immutable/)
    await assert.rejects(db.studioPdfRevision.delete({ where: { id: rev1 } }), /immutable/)
    await assert.rejects(db.studioPdf.delete({ where: { id: pdfId } }), /cannot be deleted/)
    await assert.rejects(db.studioPdf.update({ where: { id: pdfId }, data: { originalName: "autre.pdf" } }), /identity immutable/)
    await assert.rejects(db.$executeRawUnsafe(`TRUNCATE "studio_pdf_revisions"`), /immutable/)
  })
  it("numérotation sans trou, révision 1 = original seul, taille cohérente, original unique par contenu", async () => {
    const base = { companyId: "coA", pdfId, sha256: sha(original), size: original.length, data: Buffer.from(original), pageCount: 2, pages: [{ x: 0, y: 0, width: 1, height: 1, rotation: 0 }, { x: 0, y: 0, width: 1, height: 1, rotation: 0 }], pageTexts: [], createdById: "uA" }
    const filled = { kind: "FILLED" as const, operations: [], operationsSha256: "a".repeat(64) }
    await assert.rejects(db.studioPdfRevision.create({ data: { ...base, revision: 9, ...filled } }), /follow the previous one/)
    await assert.rejects(db.studioPdfRevision.create({ data: { ...base, revision: 4, kind: "ORIGINAL" } }), /shape_check/)
    await assert.rejects(db.studioPdfRevision.create({ data: { ...base, revision: 4, kind: "FILLED" } }), /shape_check/, "version remplie sans éléments")
    await assert.rejects(db.studioPdfRevision.create({ data: { ...base, revision: 4, ...filled, size: 3 } }), /shape_check/)
    await assert.rejects(db.studioPdfRevision.create({ data: { ...base, revision: 4, ...filled, signerName: "Seul" } }), /shape_check/, "signataire sans empreinte du tracé")
    const other = await db.studioPdf.create({ data: { companyId: "coA", title: "Doublon", originalName: "d.pdf", createdById: "uA" } })
    await assert.rejects(db.studioPdfRevision.create({ data: { ...base, pdfId: other.id, revision: 1, kind: "ORIGINAL" } }), /Unique constraint|one_original_per_content/)
  })
})

describe("lot 3 : organiser, extraire, combiner", () => {
  let base = "", second = ""
  before(async () => {
    const r = ok(await svc.importPdf(db, A, { title: "Dossier lot 3", originalName: "l3.pdf", bytes: await pdf("L3") }))
    base = r.pdfId
    second = ok(await svc.importPdf(db, A, { title: "Annexe lot 3", originalName: "annexe.pdf", bytes: await pdf("ANNEXE") })).pdfId
  })
  const head = async (id: string) => (await getStudioPdfView(db, "coA", id, null))!.latest
  it("organiser : version ORGANIZED (pages inversées, une pivotée), plan empreint, sans signataire ; journal", async () => {
    const h = await head(base)
    const r = ok(await svc.organizePdf(db, A, base, { baseRevisionId: h.id, plan: JSON.stringify([{ page: 2, rotate: 90 }, { page: 1, rotate: 0 }]) }))
    assert.equal(r.revision, 2)
    const row = await db.studioPdfRevision.findUnique({ where: { id: r.revisionId } })
    assert.equal(row!.kind, "ORGANIZED")
    assert.equal(row!.signerName, null)
    assert.deepEqual(row!.operations, [{ page: 2, rotate: 90 }, { page: 1, rotate: 0 }])
    assert.match((row!.pageTexts as string[])[0], /Page deux/)
    assert.deepEqual((row!.pages as { rotation: number }[]).map((p) => p.rotation), [90, 0])
    const log = await db.historyLog.findFirst({ where: { entityId: base, action: "UPDATED" } })
    assert.match(log!.detail!, /version 2 enregistrée \(pages réordonnées, 1 page pivotée\)/)
  })
  it("organiser : refus d'un plan inchangé, vide, invalide, d'une version périmée et d'une autre entreprise", async () => {
    const h = await head(base)
    const id2 = JSON.stringify([{ page: 1, rotate: 0 }, { page: 2, rotate: 0 }])
    assert.equal(ko(await svc.organizePdf(db, A, base, { baseRevisionId: h.id, plan: id2 })), PDF_ERRORS.planUnchanged)
    assert.equal(ko(await svc.organizePdf(db, A, base, { baseRevisionId: h.id, plan: "[]" })), PDF_ERRORS.planEmpty)
    assert.equal(ko(await svc.organizePdf(db, A, base, { baseRevisionId: h.id, plan: JSON.stringify([{ page: 9, rotate: 0 }]) })), PDF_ERRORS.plan)
    const v1 = (await getStudioPdfView(db, "coA", base, 1))!.shown.id
    assert.equal(ko(await svc.organizePdf(db, A, base, { baseRevisionId: v1, plan: JSON.stringify([{ page: 1, rotate: 0 }]) })), PDF_ERRORS.notLatest)
    assert.equal(ko(await svc.organizePdf(db, B, base, { baseRevisionId: h.id, plan: JSON.stringify([{ page: 1, rotate: 0 }]) })), PDF_ERRORS.notFound)
    assert.equal(await db.studioPdfRevision.count({ where: { pdfId: base } }), 2)
  })
  it("extraire : nouveau PDF (EXTRACTED) d'une page, sources figées, PDF d'origine inchangé ; titre par défaut", async () => {
    const v1 = (await getStudioPdfView(db, "coA", base, 1))!.shown
    const r = ok(await svc.extractPages(db, A2, base, { revisionId: v1.id, plan: JSON.stringify([{ page: 2, rotate: 0 }]), title: "" }))
    assert.equal(r.duplicate, false)
    const v = (await getStudioPdfView(db, "coA", r.pdfId, null))!
    assert.equal(v.origin, "EXTRACTED")
    assert.equal(v.title, "Dossier lot 3 - pages 2")
    assert.deepEqual(v.sources, [{ pdfId: base, revisionId: v1.id, revision: 1, title: "Dossier lot 3", pages: [2] }])
    assert.equal(v.shown.pageCount, 1)
    assert.match(v.pageTexts[0], /Page deux/)
    assert.equal(await db.studioPdfRevision.count({ where: { pdfId: base } }), 2, "source inchangée")
    const again = ok(await svc.extractPages(db, A, base, { revisionId: v1.id, plan: JSON.stringify([{ page: 2, rotate: 0 }]), title: "Dossier lot 3 - pages 2" }))
    // Assemblage déterministe (aucune date ni identifiant aléatoire écrits) : même extraction ⇒ fiche existante rouverte.
    assert.deepEqual(again, { pdfId: r.pdfId, duplicate: true })
    assert.equal(ko(await svc.extractPages(db, A, base, { revisionId: v1.id, plan: "[]", title: "" })), PDF_ERRORS.extractEmpty)
    assert.equal(ko(await svc.extractPages(db, A, base, { revisionId: v1.id, plan: JSON.stringify([{ page: 1, rotate: 0 }, { page: 2, rotate: 0 }]), title: "" })), PDF_ERRORS.extractAll)
    assert.equal(ko(await svc.extractPages(db, B, base, { revisionId: v1.id, plan: JSON.stringify([{ page: 1, rotate: 0 }]), title: "" })), PDF_ERRORS.notFound)
  })
  it("combiner : dernière version de chaque PDF, dans l'ordre ; refus : un seul PDF, doublon, PDF d'une autre entreprise", async () => {
    const r = ok(await svc.combinePdfs(db, A, { ids: JSON.stringify([second, base]), title: "Dossier complet" }))
    const v = (await getStudioPdfView(db, "coA", r.pdfId, null))!
    assert.equal(v.origin, "COMBINED")
    assert.equal(v.shown.pageCount, 4)
    assert.match(v.pageTexts[0], /ANNEXE/)
    assert.match(v.pageTexts[2], /Page deux/, "dernière version (réorganisée) du second PDF")
    assert.deepEqual(v.sources.map((x) => [x.pdfId, x.revision]), [[second, 1], [base, 2]])
    const log = await db.historyLog.findFirst({ where: { entityId: r.pdfId, action: "CREATED" } })
    assert.match(log!.detail!, /combiné depuis « Annexe lot 3 » v1, « Dossier lot 3 » v2/)
    assert.equal(ko(await svc.combinePdfs(db, A, { ids: JSON.stringify([base]), title: "" })), PDF_ERRORS.combineParts)
    assert.equal(ko(await svc.combinePdfs(db, A, { ids: JSON.stringify([base, base]), title: "" })), PDF_ERRORS.combineDuplicate)
    const bPdf = (await listStudioPdfs(db, "coB"))[0].id
    assert.equal(ko(await svc.combinePdfs(db, A, { ids: JSON.stringify([base, bPdf]), title: "" })), PDF_ERRORS.sourceMissing)
  })
  it("base : origine et sources figées ; importé sans sources ; dérivé avec sources ; réorganisée sans signataire", async () => {
    await assert.rejects(db.studioPdf.update({ where: { id: base }, data: { origin: "COMBINED" } }), /identity immutable|origin_check/)
    await assert.rejects(db.studioPdf.create({ data: { companyId: "coA", title: "Sans source", originalName: "x.pdf", origin: "COMBINED", createdById: "uA" } }), /origin_check/)
    await assert.rejects(db.studioPdf.create({ data: { companyId: "coA", title: "Importé sourcé", originalName: "x.pdf", sources: [{ pdfId: "x" }], createdById: "uA" } }), /origin_check/)
    const h = await head(base)
    const rowData = await db.studioPdfRevision.findUnique({ where: { id: h.id } })
    await assert.rejects(db.studioPdfRevision.create({ data: {
      companyId: "coA", pdfId: base, revision: h.revision + 1, kind: "ORGANIZED", sha256: rowData!.sha256, size: rowData!.size, data: rowData!.data,
      pageCount: rowData!.pageCount, pages: rowData!.pages as object, pageTexts: [], operations: [{ page: 1, rotate: 0 }], operationsSha256: "b".repeat(64),
      signerName: "Intrus", signatureSha256: "c".repeat(64), createdById: "uA",
    } }), /shape_check/)
  })
})
