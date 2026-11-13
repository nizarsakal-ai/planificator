// SPEC-INVOICE-IMPORT-001 — tests PostgreSQL (base jetable migrée) : export « façon Tiime » + ZIP, autre logiciel (XLSX + association
// des colonnes), PDF scanné (OCR simulé), PDF texte, réimport sans doublon, conflit jamais écrasé, isolation société, concurrence,
// et absence de tout effet sur la facturation, les règlements, la numérotation, les courriers, la comptabilité et les fournisseurs.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { buildFlateCompressedMultiBlockPdf, buildMinimalEmptyPdf, buildMinimalTextPdf } from "@/lib/acquisition/extraction/pdf-text-extract"
import { setOcrProviderForTests, type OcrExtraction } from "@/lib/accounting/c5/ocr-provider"
import { addFileToBatch, cancelBatch, commitBatch, createBatch, getBatchView, getImportedFile, listImportedInvoices, updateBatchMapping, updateBatchRows } from "@/lib/invoice-import/import.service"
import type { AnalyzedRow } from "@/lib/invoice-import/types"
import { SYNTHETIC_TIIME_CSV, buildXlsx, buildZip } from "../helpers"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "impA", userId: "impAdmA" }
const B = { companyId: "impB", userId: "impAdmB" }
const pdf = (label: string) => buildMinimalTextPdf(`Piece ${label} ${"x".repeat(60)}`)
const ocr = (p: Partial<OcrExtraction>): OcrExtraction => ({ supplier: null, siret: null, invoiceNumber: null, date: null, totalHTCents: null, vatCents: null, totalTTCCents: null, vatRateBp: null, category: null, confidence: {}, amountsAdjusted: false, rawText: "", ...p })

async function view(ctx: typeof A, id: string) { const v = await getBatchView(db, ctx, id); if (!v) throw new Error("lot introuvable"); return v }
const byNumber = (rows: AnalyzedRow[], number: string) => { const a = rows.find((r) => r.row.number === number); if (!a) throw new Error(`ligne ${number} absente`); return a }
async function must<T>(p: Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<T> { const r = await p; if (!r.ok) throw new Error(r.error); return r.value }

/** Tables qui ne doivent JAMAIS bouger pendant un import (facturation, règlements, numérotation, courriers, comptabilité, fournisseurs). */
async function untouched() {
  const [invoices, payments, counters, mails, entries, postings, supplierInvoices, supplierFiles, bank] = await Promise.all([
    db.invoice.count(), db.invoicePayment.count(), db.documentCounter.findMany({ orderBy: { id: "asc" } }), db.billingMailLog.count(), db.journalEntry.count(),
    db.accountingDocumentPosting.count(), db.supplierInvoice.count(), db.supplierInvoiceFile.count(), db.bankTransaction.count(),
  ])
  return JSON.stringify({ invoices, payments, counters: counters.map((c) => [c.type, c.year, c.lastValue]), mails, entries, postings, supplierInvoices, supplierFiles, bank })
}
let baseline = ""

before(async () => {
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,"updatedAt") VALUES ('impA','GALYA TEST','imp-a','12345678900012',now()),('impB','Autre Société','imp-b','98765432100011',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('impAdmA','imp-a@example.test','x','ADMIN','impA',now()),('impAdmB','imp-b@example.test','x','ADMIN','impB',now())`)
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,"updatedAt") VALUES ('impClA','impA','Mairie de Testville',now()),('impClA2','impA','Dupont Événements',now()),('impClB','impB','Mairie de Testville',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('impWA','impA','impClA','impAdmA','Fête de la ville',now()),('impWB','impB','impClB','impAdmB','Chantier B',now())`)
  // Pièce émise par Planificator : sert au rattachement d'un avoir importé et au contrôle de collision de numéro.
  await db.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,status,kind,"createdById","updatedAt") VALUES ('impNative','impA','impWA','impClA','FAC-2026-0001','DRAFT','INVOICE','impAdmA',now())`)
  await db.$executeRawUnsafe(`INSERT INTO document_counters(id,"companyId",type,year,"lastValue") VALUES ('impCounter','impA','INVOICE',2026,1)`)
  baseline = await untouched()
})
after(async () => { setOcrProviderForTests(null); await db.$disconnect() })

describe("export « façon Tiime » (synthétique) en ZIP avec PDF", () => {
  let batchId = ""
  it("analyse : lignes, PDF rattachés par nom, client inconnu à confirmer, avoir lié à sa facture du lot", async () => {
    batchId = (await createBatch(db, A, { sourceSystem: "TIIME", sourceLabel: null })).id
    const zip = buildZip([{ name: "export/factures.csv", data: Buffer.from(SYNTHETIC_TIIME_CSV, "utf8") }, { name: "pdf/F-2025-001.pdf", data: pdf("F-2025-001"), deflate: true }, { name: "pdf/AV-2025-001.pdf", data: pdf("AV-2025-001") }])
    const r = await must(addFileToBatch(db, A, batchId, { name: "tiime-export.zip", data: zip }))
    assert.deepEqual([r.tables, r.added, r.attached], [1, 3, 2])
    const v = await view(A, batchId)
    assert.deepEqual(v.summary, { total: 3, toImport: 2, toAttach: 0, skipped: 0, blocked: 1, supplier: 0 })
    assert.ok(byNumber(v.analyzed, "F-2025-001").row.fileId)
    assert.deepEqual(byNumber(v.analyzed, "F-2025-002").anomalies.map((a) => a.code).sort(), ["CLIENT_MISSING", "PDF_MISSING"])
    assert.equal(byNumber(v.analyzed, "AV-2025-001").credited?.type, "BATCH")
  })
  it("validation refusée tant qu'une ligne est bloquée ; rien n'est écrit", async () => {
    const v = await view(A, batchId)
    const r = await commitBatch(db, A, batchId, v.version)
    assert.equal(r.ok, false)
    assert.equal(await db.importedInvoice.count(), 0)
    assert.equal((await view(A, batchId)).status, "PREVIEW")
  })
  it("corrections de l'aperçu : création explicite du client, chantier facultatif, verrou optimiste, identifiants étrangers refusés", async () => {
    let v = await view(A, batchId)
    const unknown = byNumber(v.analyzed, "F-2025-002").row.id, first = byNumber(v.analyzed, "F-2025-001").row.id
    assert.equal((await updateBatchRows(db, A, batchId, v.version - 1, [{ id: unknown, createClient: true }])).ok, false) // version périmée
    assert.equal((await updateBatchRows(db, B, batchId, v.version, [{ id: unknown, createClient: true }])).ok, false) // autre société
    await must(updateBatchRows(db, A, batchId, v.version, [{ id: unknown, clientId: "impClB", worksiteId: "impWB" }])) // client et chantier d'une autre société
    v = await view(A, batchId)
    assert.equal(byNumber(v.analyzed, "F-2025-002").outcome, "BLOCKED")
    await must(updateBatchRows(db, A, batchId, v.version, [{ id: unknown, clientId: null, createClient: true, worksiteId: null }, { id: first, worksiteId: "impWA" }]))
    v = await view(A, batchId)
    assert.equal(v.summary.blocked, 0)
    assert.equal(v.summary.toImport, 3)
  })
  it("validation : pièces créées avec numéro, statut et référence d'origine ; avoir relié ; client créé ; aucun effet de bord", async () => {
    const v = await view(A, batchId)
    const s = await must(commitBatch(db, A, batchId, v.version))
    assert.equal(s.toImport, 3)
    const rows = await db.importedInvoice.findMany({ where: { companyId: "impA" }, orderBy: { number: "asc" }, include: { client: true } })
    assert.deepEqual(rows.map((r) => [r.number, r.kind, r.status, r.sourceStatus, r.sourceSystem, r.totalTTCCents, r.worksiteId, r.fileId !== null]), [
      ["AV-2025-001", "CREDIT_NOTE", "ISSUED", "Émis", "TIIME", BigInt(12000), null, true],
      ["F-2025-001", "INVOICE", "PAID", "Payée", "TIIME", BigInt(120000), "impWA", true],
      ["F-2025-002", "INVOICE", "ISSUED", "En attente", "TIIME", BigInt(60000), null, false],
    ])
    assert.equal(rows[0].creditedImportedInvoiceId, rows[1].id)
    assert.equal(rows[2].client.name, "Client Inconnu SARL")
    assert.equal(await untouched(), baseline)
    assert.equal((await commitBatch(db, A, batchId, v.version + 1)).ok, false) // lot déjà validé : rejeu refusé
    assert.equal(await db.importedInvoice.count(), 3)
  })
  it("PDF privé : accessible dans la société, introuvable depuis une autre", async () => {
    const inv = await db.importedInvoice.findFirstOrThrow({ where: { companyId: "impA", number: "F-2025-001" } })
    assert.equal((await getImportedFile(db, "impA", { invoiceId: inv.id }))?.mime, "application/pdf")
    assert.equal(await getImportedFile(db, "impB", { invoiceId: inv.id }), null)
    assert.equal((await listImportedInvoices(db, "impB", {})).total, 0)
    assert.equal((await listImportedInvoices(db, "impA", { clientId: "impClA" })).total, 2)
  })
})

describe("réimport", () => {
  it("même export : tout est reconnu comme déjà importé, aucun doublon, PDF manquant simplement ajouté", async () => {
    const id = (await createBatch(db, A, { sourceSystem: "TIIME", sourceLabel: null })).id
    await must(addFileToBatch(db, A, id, { name: "factures.csv", data: Buffer.from(SYNTHETIC_TIIME_CSV, "utf8") }))
    let v = await view(A, id)
    assert.deepEqual([v.summary.toImport, v.summary.skipped, v.summary.blocked], [0, 3, 0])
    assert.equal((await commitBatch(db, A, id, v.version)).ok, false) // rien à importer
    await must(addFileToBatch(db, A, id, { name: "F-2025-002.pdf", data: pdf("F-2025-002") }))
    v = await view(A, id)
    assert.deepEqual([v.summary.toAttach, v.summary.skipped], [1, 2])
    await must(commitBatch(db, A, id, v.version))
    assert.equal(await db.importedInvoice.count({ where: { companyId: "impA" } }), 3)
    assert.ok((await db.importedInvoice.findFirstOrThrow({ where: { companyId: "impA", number: "F-2025-002" } })).fileId)
    assert.equal(await untouched(), baseline)
  })
  it("même numéro, montant différent : conflit signalé, pièce existante jamais modifiée, même après confirmation", async () => {
    const id = (await createBatch(db, A, { sourceSystem: "TIIME", sourceLabel: null })).id
    const changed = SYNTHETIC_TIIME_CSV.replace("1 000,00;200,00;1 200,00;Payée", "2 000,00;400,00;2 400,00;Payée") + "\r\nF-2025-003;Facture;Mairie de Testville;01/02/2025;;10,00;2,00;12,00;Payée;"
    await must(addFileToBatch(db, A, id, { name: "factures.csv", data: Buffer.from(changed, "utf8") }))
    let v = await view(A, id)
    const conflict = byNumber(v.analyzed, "F-2025-001")
    assert.deepEqual([conflict.outcome, conflict.conflict?.differences.map((d) => d.field)], ["BLOCKED", ["Montant HT", "TVA", "Montant TTC"]])
    assert.equal((await commitBatch(db, A, id, v.version)).ok, false)
    await must(updateBatchRows(db, A, id, v.version, [{ id: conflict.row.id, decision: "KEEP" }]))
    v = await view(A, id)
    await must(commitBatch(db, A, id, v.version))
    const kept = await db.importedInvoice.findFirstOrThrow({ where: { companyId: "impA", number: "F-2025-001" } })
    assert.deepEqual([kept.totalTTCCents, kept.updatedById], [BigInt(120000), null])
    assert.equal(await db.importedInvoice.count({ where: { companyId: "impA" } }), 4) // seule F-2025-003 est nouvelle
  })
  it("deux validations simultanées de lots portant la même pièce : une seule passe, aucun doublon", async () => {
    const csv = "Numéro;Client;Date;Total HT;Total TVA;Total TTC\nF-RACE-1;Mairie de Testville;05/02/2025;100,00;20,00;120,00\n"
    const ids = await Promise.all([0, 1].map(async () => { const id = (await createBatch(db, A, { sourceSystem: "TIIME", sourceLabel: null })).id; await must(addFileToBatch(db, A, id, { name: "race.csv", data: Buffer.from(csv) })); return id }))
    const versions = await Promise.all(ids.map(async (id) => (await view(A, id)).version))
    const results = await Promise.all(ids.map((id, i) => commitBatch(db, A, id, versions[i])))
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.equal(await db.importedInvoice.count({ where: { companyId: "impA", number: "F-RACE-1" } }), 1)
    const loser = ids[results.findIndex((r) => !r.ok)]
    assert.equal((await view(A, loser)).status, "PREVIEW") // le perdant reste en aperçu, rien d'écrit
  })
})

describe("autre logiciel : XLSX, association des colonnes mémorisée", () => {
  const sheet = async (n: string) => buildXlsx([["Réf", "Tiers", "Jour", "Base", "Taxe", "Somme"], [n, "Dupont Événements", new Date("2025-03-02T00:00:00Z"), 250, 50, 300]])
  it("en-têtes non reconnus ⇒ aucune ligne tant que les colonnes ne sont pas associées ; association refusée si invalide", async () => {
    const id = (await createBatch(db, A, { sourceSystem: "OTHER", sourceLabel: "Logiciel X" })).id
    const r = await must(addFileToBatch(db, A, id, { name: "export.xlsx", data: await sheet("X-1") }))
    assert.equal(r.added, 0)
    let v = await view(A, id)
    assert.deepEqual(v.table?.headers, ["Réf", "Tiers", "Jour", "Base", "Taxe", "Somme"])
    assert.equal((await updateBatchMapping(db, A, id, v.version, { headerRows: 1, number: 0, client: 0 })).ok, false)
    await must(updateBatchMapping(db, A, id, v.version, { headerRows: 1, number: 0, client: 1, issueDate: 2, totalHT: 3, vat: 4, totalTTC: 5 }))
    v = await view(A, id)
    assert.deepEqual([v.summary.toImport, v.analyzed[0].resolvedClientId, v.analyzed[0].row.ttcCents], [1, "impClA2", "30000"])
    assert.equal((await addFileToBatch(db, A, id, { name: "autre.csv", data: Buffer.from("a;b\n1;2") })).ok, false) // un seul tableau par lot
    await must(commitBatch(db, A, id, v.version))
    assert.equal((await db.importedInvoice.findFirstOrThrow({ where: { companyId: "impA", number: "X-1" } })).sourceSystem, "Logiciel X")
  })
  it("export suivant du même logiciel : association reproposée ; autre société : rien de mémorisé", async () => {
    const id = (await createBatch(db, A, { sourceSystem: "OTHER", sourceLabel: "Logiciel X" })).id
    assert.equal((await must(addFileToBatch(db, A, id, { name: "export2.xlsx", data: await sheet("X-2") }))).added, 1)
    await must(cancelBatch(db, A, id))
    const idB = (await createBatch(db, B, { sourceSystem: "OTHER", sourceLabel: "Logiciel X" })).id
    assert.equal((await must(addFileToBatch(db, B, idB, { name: "export2.xlsx", data: await sheet("X-2") }))).added, 0)
  })
})

describe("PDF seuls", () => {
  it("PDF scanné (sans texte) : OCR existant appelé tel quel ; émetteur = société ⇒ facture client à compléter", async () => {
    setOcrProviderForTests({ name: "test", extract: async () => ocr({ supplier: "Galya Test SAS", siret: "12345678900012", invoiceNumber: "SCAN-1", date: "2025-04-01", totalHTCents: BigInt(5000), vatCents: BigInt(1000), totalTTCCents: BigInt(6000) }) })
    const id = (await createBatch(db, A, { sourceSystem: "PDF", sourceLabel: null })).id
    await must(addFileToBatch(db, A, id, { name: "scan.pdf", data: buildMinimalEmptyPdf() }))
    let v = await view(A, id)
    assert.deepEqual([v.analyzed[0].row.kind, v.analyzed[0].row.number, v.analyzed[0].row.ttcCents, v.analyzed[0].outcome], ["INVOICE", "SCAN-1", "6000", "BLOCKED"]) // client à choisir
    await must(updateBatchRows(db, A, id, v.version, [{ id: v.analyzed[0].row.id, clientId: "impClA" }]))
    v = await view(A, id)
    await must(commitBatch(db, A, id, v.version))
    assert.ok((await db.importedInvoice.findFirstOrThrow({ where: { companyId: "impA", number: "SCAN-1" } })).fileId)
  })
  it("PDF scanné émis par un tiers : facture fournisseur, jamais importée, aucune écriture dans le module fournisseurs", async () => {
    setOcrProviderForTests({ name: "test", extract: async () => ocr({ supplier: "Loueur de Sono SARL", siret: "55555555500055", invoiceNumber: "LS-9", date: "2025-04-02", totalHTCents: BigInt(100), vatCents: BigInt(20), totalTTCCents: BigInt(120) }) })
    const id = (await createBatch(db, A, { sourceSystem: "PDF", sourceLabel: null })).id
    await must(addFileToBatch(db, A, id, { name: "fournisseur.png", data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("image-de-test")]) }))
    const v = await view(A, id)
    assert.deepEqual([v.analyzed[0].outcome, v.summary.supplier], ["REDIRECT", 1])
    assert.equal((await commitBatch(db, A, id, v.version)).ok, false)
    assert.equal(await untouched(), baseline)
  })
  it("OCR désactivé (comportement par défaut) : la pièce est conservée et la ligne reste à saisir", async () => {
    setOcrProviderForTests(null)
    const id = (await createBatch(db, A, { sourceSystem: "PDF", sourceLabel: null })).id
    await must(addFileToBatch(db, A, id, { name: "scan2.jpg", data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg-de-test")]) }))
    const v = await view(A, id)
    assert.ok(v.analyzed[0].row.fileId)
    assert.match(v.analyzed[0].row.extractionNote ?? "", /OCR/)
    assert.equal(v.analyzed[0].outcome, "BLOCKED")
  })
  it("PDF avec texte : champs lus, client reconnu dans le texte, avoir relié à une facture Planificator ; fichier non pris en charge refusé", async () => {
    const id = (await createBatch(db, A, { sourceSystem: "PDF", sourceLabel: null })).id
    await must(addFileToBatch(db, A, id, { name: "avoir.pdf", data: buildFlateCompressedMultiBlockPdf(["GALYA TEST", "Avoir no AV-TXT-1", "Avoir sur la facture no FAC-2026-0001", "Date : 10/02/2025", "Client : Mairie de Testville", "Total HT 100,00", "Total TVA 20,00", "Total TTC 120,00"]) }))
    const r = await must(addFileToBatch(db, A, id, { name: "notes.exe", data: Buffer.from("MZ binaire") }))
    assert.equal(r.warnings.length, 1)
    const v = await view(A, id)
    const a = v.analyzed[0]
    assert.deepEqual([a.row.kind, a.row.number, a.row.ttcCents, a.resolvedClientId, a.credited?.type, a.outcome], ["CREDIT_NOTE", "AV-TXT-1", "12000", "impClA", "NATIVE", "IMPORT"])
    await must(commitBatch(db, A, id, v.version))
    assert.equal((await db.importedInvoice.findFirstOrThrow({ where: { companyId: "impA", number: "AV-TXT-1" } })).creditedInvoiceId, "impNative")
    assert.equal(await untouched(), baseline)
  })
  it("numéro d'une pièce Planificator : bloquant ; annulation : pièces orphelines supprimées, pièces rattachées conservées", async () => {
    const id = (await createBatch(db, A, { sourceSystem: "TIIME", sourceLabel: null })).id
    await must(addFileToBatch(db, A, id, { name: "c.csv", data: Buffer.from("Numéro;Client;Date;Total HT;Total TVA;Total TTC\nFAC-2026-0001;Mairie de Testville;05/02/2025;100,00;20,00;120,00\n") }))
    await must(addFileToBatch(db, A, id, { name: "FAC-2026-0001.pdf", data: pdf("orpheline") }))
    const v = await view(A, id)
    assert.equal(v.analyzed[0].anomalies.find((a) => a.blocking)?.code, "NATIVE_NUMBER_COLLISION")
    const before = await db.importedDocumentFile.count({ where: { companyId: "impA" } })
    await must(cancelBatch(db, A, id))
    assert.equal(await db.importedDocumentFile.count({ where: { companyId: "impA" } }), before - 1)
    assert.equal(await getBatchView(db, B, id), null)
  })
})

describe("filets en base", () => {
  it("montants incohérents, lien d'avoir sur une facture, doublon d'identité : refusés par PostgreSQL", async () => {
    const batch = await db.invoiceImportBatch.findFirstOrThrow({ where: { companyId: "impA", status: "COMMITTED" } })
    const base = { companyId: "impA", batchId: batch.id, sourceSystem: "T", clientId: "impClA", issueDate: new Date("2025-01-01"), contentHash: "h", createdById: "impAdmA" }
    await assert.rejects(db.importedInvoice.create({ data: { ...base, kind: "INVOICE", number: "CHK-1", numberKey: "CHK1", totalHTCents: BigInt(100), vatCents: BigInt(20), totalTTCCents: BigInt(999) } }))
    await assert.rejects(db.importedInvoice.create({ data: { ...base, kind: "INVOICE", number: "CHK-2", numberKey: "CHK2", totalHTCents: BigInt(100), vatCents: BigInt(20), totalTTCCents: BigInt(120), creditedInvoiceId: "impNative" } }))
    await assert.rejects(db.importedInvoice.create({ data: { ...base, kind: "INVOICE", number: "f2025001", numberKey: "F2025001", totalHTCents: BigInt(100), vatCents: BigInt(20), totalTTCCents: BigInt(120) } }))
    await assert.rejects(db.importedInvoice.create({ data: { ...base, kind: "INVOICE", number: "CHK-3", numberKey: "CHK3", clientId: "impClB", totalHTCents: BigInt(100), vatCents: BigInt(20), totalTTCCents: BigInt(120) } })) // client d'une autre société
  })
})
