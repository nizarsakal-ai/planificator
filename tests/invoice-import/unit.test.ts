// SPEC-INVOICE-IMPORT-001 — tests unitaires (sans base) : ZIP, tableurs, association de colonnes, normalisation, texte PDF, analyse.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { ZipError, readZip } from "@/lib/invoice-import/zip"
import { completeAmounts, detectKind, mapStatus, nameKey, numberKey, parseImportAmount, parseImportDate } from "@/lib/invoice-import/normalize"
import { decodeText, guessMapping, headerSignature, readTable, tableToPreviewRows, validateMapping } from "@/lib/invoice-import/tabular"
import { issuerIsOwnCompany, parseInvoiceText } from "@/lib/invoice-import/pdf-extract"
import { analyzeBatch, rowContentHash, summarize, type AnalysisState, type ExistingImported } from "@/lib/invoice-import/analyze"
import { eurosToCents, centsToEuros } from "@/lib/invoice-import/format"
import { isInvoiceImportEnabled, isBankAccountVerificationEnabled } from "@/lib/invoice-import/invoice-import-feature-flag"
import type { PreviewRow } from "@/lib/invoice-import/types"
import { SYNTHETIC_TIIME_CSV, buildXlsx, buildZip } from "./helpers"

let n = 0
const id = () => `row-${++n}`
const row = (p: Partial<PreviewRow>): PreviewRow => ({
  id: id(), origin: { type: "table", file: "t.csv", line: 2 }, kind: "INVOICE", number: "F-1", clientName: "Mairie de Testville", clientId: null, createClient: false, worksiteId: null,
  issueDate: "2025-01-15", dueDate: null, htCents: "100000", vatCents: "20000", ttcCents: "120000", sourceStatus: "Payée", status: "PAID", sourceReference: null, creditedNumber: null,
  fileId: "file1", fileName: "F-1.pdf", expectedFileName: null, decision: null, excluded: false, extractionNote: null, ...p,
})
const state = (p: Partial<AnalysisState> = {}): AnalysisState => ({ clients: [{ id: "c1", name: "Mairie de Testville" }, { id: "c2", name: "Dupont Événements" }], imported: [], native: [], worksiteIds: new Set(), ...p })
const existing = (r: PreviewRow, clientId: string, p: Partial<ExistingImported> = {}): ExistingImported => ({
  id: "imp1", kind: r.kind as "INVOICE", number: r.number, numberKey: numberKey(r.number), contentHash: rowContentHash(r, clientId), fileId: "file1", clientId, clientName: "Mairie de Testville",
  issueDate: r.issueDate as string, dueDate: r.dueDate, htCents: r.htCents as string, vatCents: r.vatCents as string, ttcCents: r.ttcCents as string, status: r.status, creditedNumber: r.creditedNumber, ...p,
})

describe("drapeaux", () => {
  it("fail-closed : seule la valeur exacte « true » active", () => {
    assert.equal(isInvoiceImportEnabled({}), false)
    assert.equal(isInvoiceImportEnabled({ INVOICE_IMPORT_ENABLED: "1" }), false)
    assert.equal(isInvoiceImportEnabled({ INVOICE_IMPORT_ENABLED: "true" }), true)
    assert.equal(isBankAccountVerificationEnabled({ BANK_ACCOUNT_VERIFICATION_ENABLED: "TRUE" }), false)
  })
})

describe("ZIP", () => {
  it("lit STORE et DEFLATE, ignore dossiers et métadonnées macOS, ne garde que le nom de base", () => {
    const zip = buildZip([{ name: "export/factures.csv", data: Buffer.from("a;b") }, { name: "pdf/F-1.pdf", data: Buffer.from("%PDF-1.4 x".repeat(50)), deflate: true }, { name: "__MACOSX/._F-1.pdf", data: Buffer.from("x") }, { name: "../../etc/passwd", data: Buffer.from("root") }])
    const entries = readZip(zip)
    assert.deepEqual(entries.map((e) => e.name), ["factures.csv", "F-1.pdf", "passwd"])
    assert.equal(entries[1].data.length, 500)
  })
  it("refuse archive chiffrée, trop d'entrées, entrée trop grosse, taille mensongère, contenu illisible", () => {
    const code = (fn: () => unknown) => { try { fn() } catch (e) { return e instanceof ZipError ? e.code : "AUTRE" } return "OK" }
    assert.equal(code(() => readZip(buildZip([{ name: "a.pdf", data: Buffer.from("x"), flags: 1 }]))), "ZIP_ENCRYPTED")
    assert.equal(code(() => readZip(buildZip([{ name: "a", data: Buffer.from("x") }, { name: "b", data: Buffer.from("y") }]), { maxEntries: 1, maxEntryBytes: 10, maxTotalBytes: 10, maxRatio: 10 })), "ZIP_TOO_MANY_ENTRIES")
    assert.equal(code(() => readZip(buildZip([{ name: "a", data: Buffer.alloc(100) }]), { maxEntries: 5, maxEntryBytes: 10, maxTotalBytes: 1000, maxRatio: 1000 })), "ZIP_ENTRY_TOO_LARGE")
    assert.equal(code(() => readZip(buildZip([{ name: "a", data: Buffer.alloc(50_000), deflate: true }]), { maxEntries: 5, maxEntryBytes: 1e6, maxTotalBytes: 1e6, maxRatio: 20 })), "ZIP_TOO_LARGE")
    assert.equal(code(() => readZip(buildZip([{ name: "a", data: Buffer.alloc(5000, 1), deflate: true, fakeSize: 10 }]))), "ZIP_INVALID")
    assert.equal(code(() => readZip(Buffer.from("pas un zip"))), "ZIP_INVALID")
  })
})

describe("normalisation", () => {
  it("clés de numéro et de nom", () => {
    assert.equal(numberKey("FA 2024-001"), numberKey("fa2024/001"))
    assert.equal(nameKey("SARL Dupont Événements"), nameKey("dupont evenements"))
  })
  it("dates et montants", () => {
    assert.equal(parseImportDate("15/01/2025"), "2025-01-15")
    assert.equal(parseImportDate("2025-01-15T00:00:00.000Z"), "2025-01-15")
    assert.equal(parseImportDate("15/01/25"), "2025-01-15")
    assert.equal(parseImportDate(45672), "2025-01-15")
    assert.equal(parseImportDate("31/02/2025"), null)
    assert.equal(parseImportAmount("1 234,56 €"), BigInt(123456))
    assert.equal(parseImportAmount(12.5), BigInt(1250))
    assert.equal(parseImportAmount("abc"), null)
    assert.deepEqual(completeAmounts({ ht: BigInt(-10000), vat: null, ttc: BigInt(-12000) }), { ht: BigInt(10000), vat: BigInt(2000), ttc: BigInt(12000) })
    assert.deepEqual(completeAmounts({ ht: null, vat: null, ttc: BigInt(12000) }), { ht: null, vat: null, ttc: BigInt(12000) })
  })
  it("nature et statut", () => {
    assert.equal(detectKind("Avoir", "X1", null), "CREDIT_NOTE")
    assert.equal(detectKind("", "AV-2025-001", null), "CREDIT_NOTE")
    assert.equal(detectKind("", "F-1", BigInt(-100)), "CREDIT_NOTE")
    assert.equal(detectKind("Facture fournisseur", "F-1", null), "SUPPLIER")
    assert.equal(detectKind("Facture", "F-1", BigInt(100)), "INVOICE")
    assert.equal(mapStatus("Payée"), "PAID")
    assert.equal(mapStatus("Impayée"), "ISSUED")
    assert.equal(mapStatus("En attente de paiement"), "ISSUED")
    assert.equal(mapStatus("Partiellement payée"), "PARTIALLY_PAID")
    assert.equal(mapStatus("En retard"), "OVERDUE")
    assert.equal(mapStatus("Annulée"), "CANCELLED")
    assert.equal(mapStatus("???"), "UNKNOWN")
  })
  it("saisie des montants dans l'aperçu", () => {
    assert.equal(eurosToCents("1 234,5"), "123450")
    assert.equal(eurosToCents(""), null)
    assert.equal(eurosToCents("12,345"), undefined)
    assert.equal(centsToEuros("5"), "0,05")
  })
})

describe("tableurs et association des colonnes", () => {
  it("export synthétique « façon Tiime » : colonnes devinées, avoir en valeur absolue relié à sa facture", async () => {
    const table = await readTable(Buffer.from(SYNTHETIC_TIIME_CSV, "utf8"), "tiime.csv")
    const m = guessMapping(table.rows)
    assert.deepEqual({ number: m.number, kind: m.kind, client: m.client, issueDate: m.issueDate, dueDate: m.dueDate, totalHT: m.totalHT, vat: m.vat, totalTTC: m.totalTTC, status: m.status, creditedNumber: m.creditedNumber, headerRows: m.headerRows }, { number: 0, kind: 1, client: 2, issueDate: 3, dueDate: 4, totalHT: 5, vat: 6, totalTTC: 7, status: 8, creditedNumber: 9, headerRows: 1 })
    const rows = tableToPreviewRows(table, m, "tiime.csv", id)
    assert.equal(rows.length, 3)
    assert.deepEqual([rows[0].number, rows[0].issueDate, rows[0].ttcCents, rows[0].status, rows[0].sourceStatus], ["F-2025-001", "2025-01-15", "120000", "PAID", "Payée"])
    assert.deepEqual([rows[2].kind, rows[2].htCents, rows[2].vatCents, rows[2].ttcCents, rows[2].creditedNumber], ["CREDIT_NOTE", "10000", "2000", "12000", "F-2025-001"])
  })
  it("autre logiciel (XLSX, en-têtes anglais, ligne de titre avant l'en-tête, dates Excel)", async () => {
    const buf = await buildXlsx([["Export ACME Billing"], ["Invoice Number", "Customer", "Invoice Date", "Net Amount", "Tax Amount", "Total Amount", "Status", "File"], ["INV-77", "Dupont Événements", new Date("2025-03-02T00:00:00Z"), 250, 50, 300, "Paid", "INV-77.pdf"]])
    const table = await readTable(buf, "acme.xlsx")
    const m = guessMapping(table.rows)
    assert.equal(m.headerRows, 2)
    const rows = tableToPreviewRows(table, m, "acme.xlsx", id)
    assert.deepEqual([rows[0].number, rows[0].clientName, rows[0].issueDate, rows[0].htCents, rows[0].vatCents, rows[0].ttcCents, rows[0].status, rows[0].expectedFileName], ["INV-77", "Dupont Événements", "2025-03-02", "25000", "5000", "30000", "PAID", "INV-77.pdf"])
  })
  it("association saisie : validation et signature d'en-têtes stable", async () => {
    const table = await readTable(Buffer.from("Ref,Tiers,Jour,Somme\nA1,Client,01/02/2025,120.00\n"), "x.csv")
    assert.equal(guessMapping(table.rows).number, undefined)
    assert.match(validateMapping({ headerRows: 1 }, 4) ?? "", /numéro/)
    assert.match(validateMapping({ headerRows: 1, number: 0, client: 0 }, 4) ?? "", /même colonne/)
    assert.match(validateMapping({ headerRows: 1, number: 9 }, 4) ?? "", /inexistante/)
    const manual = { headerRows: 1, number: 0, client: 1, issueDate: 2, totalTTC: 3 }
    assert.equal(validateMapping(manual, 4), null)
    const rows = tableToPreviewRows(table, manual, "x.csv", id)
    assert.deepEqual([rows[0].number, rows[0].ttcCents, rows[0].htCents], ["A1", "12000", null])
    assert.equal(headerSignature(table.rows, 1), headerSignature([["ref", " TIERS ", "jour", "somme"]], 1))
  })
  it("encodage Windows-1252 et refus des fichiers binaires / .xls", async () => {
    assert.equal(decodeText(Buffer.from([0x4e, 0x75, 0x6d, 0xe9, 0x72, 0x6f])), "Numéro")
    await assert.rejects(readTable(Buffer.from([0x50, 0x00, 0x01, 0x00]), "x.csv"), /illisible/)
    await assert.rejects(readTable(Buffer.from("x"), "x.xls"), /\.xls/)
  })
})

describe("texte d'un PDF", () => {
  it("facture : numéro, dates, montants", () => {
    const x = parseInvoiceText("GALYA EVENTS\nFacture N° FA-2025-014\nDate d'émission : 03/02/2025\nDate d'échéance : 05/03/2025\nClient : Mairie de Testville\nTotal HT 1 000,00 €\nTotal TVA 200,00 €\nTotal TTC 1 200,00 €")
    assert.deepEqual([x.kind, x.number, x.issueDate, x.dueDate, x.htCents, x.vatCents, x.ttcCents], ["INVOICE", "FA-2025-014", "2025-02-03", "2025-03-05", BigInt(100000), BigInt(20000), BigInt(120000)])
  })
  it("avoir relié à sa facture ; texte sans rapport ⇒ rien d'inventé", () => {
    const x = parseInvoiceText("Avoir n° AV-2025-003\nAvoir sur la facture n° FA-2025-014\nDate : 10/02/2025\nTotal HT 100,00\nTVA 20 % 20,00\nTotal TTC 120,00")
    assert.deepEqual([x.kind, x.number, x.creditedNumber, x.ttcCents], ["CREDIT_NOTE", "AV-2025-003", "FA-2025-014", BigInt(12000)])
    const y = parseInvoiceText("Compte rendu de réunion du lundi.")
    assert.deepEqual([y.kind, y.number, y.ttcCents], [null, null, null])
  })
  it("émetteur = société ? SIRET d'abord, puis nom", () => {
    const own = { name: "GALYA EVENTS", siret: "12345678900012" }
    assert.equal(issuerIsOwnCompany("Autre", "12345678900012", own), true)
    assert.equal(issuerIsOwnCompany("Galya Events SAS", "99999999900011", own), false)
    assert.equal(issuerIsOwnCompany("Galya Events SAS", null, own), true)
    assert.equal(issuerIsOwnCompany("Loueur de sono", null, own), false)
    assert.equal(issuerIsOwnCompany(null, null, own), null)
  })
})

describe("analyse du lot", () => {
  it("client exact unique ⇒ importable ; approchant, inconnu ou homonymes ⇒ confirmation obligatoire", () => {
    const ok = analyzeBatch([row({})], state())[0]
    assert.deepEqual([ok.outcome, ok.resolvedClientId], ["IMPORT", "c1"])
    const near = analyzeBatch([row({ clientName: "Dupont" })], state())[0]
    assert.deepEqual([near.outcome, near.anomalies.find((a) => a.blocking)?.code, near.clientCandidates.map((c) => c.id)], ["BLOCKED", "CLIENT_TO_CONFIRM", ["c2"]])
    assert.equal(analyzeBatch([row({ clientName: "Inconnu" })], state())[0].anomalies.find((a) => a.blocking)?.code, "CLIENT_MISSING")
    assert.equal(analyzeBatch([row({})], state({ clients: [{ id: "c1", name: "Mairie de Testville" }, { id: "c9", name: "MAIRIE DE TESTVILLE" }] }))[0].anomalies.find((a) => a.blocking)?.code, "CLIENT_AMBIGUOUS")
    assert.equal(analyzeBatch([row({ clientName: "Dupont", clientId: "c2" })], state())[0].outcome, "IMPORT")
    assert.equal(analyzeBatch([row({ clientName: "Nouveau", createClient: true })], state())[0].outcome, "IMPORT")
    assert.equal(analyzeBatch([row({ createClient: true })], state())[0].outcome, "BLOCKED")
    assert.equal(analyzeBatch([row({ clientId: "client-d-une-autre-societe" })], state())[0].outcome, "BLOCKED")
  })
  it("champs manquants, montants incohérents, chantier étranger ⇒ bloquant ; PDF manquant ⇒ simple alerte", () => {
    const codes = (p: Partial<PreviewRow>) => analyzeBatch([row(p)], state())[0].anomalies.filter((a) => a.blocking).map((a) => a.code)
    assert.deepEqual(codes({ number: " " }), ["NUMBER_MISSING"])
    assert.deepEqual(codes({ issueDate: null }), ["DATE_MISSING"])
    assert.deepEqual(codes({ vatCents: null }), ["AMOUNTS_MISSING"])
    assert.deepEqual(codes({ ttcCents: "999" }), ["AMOUNTS_INCONSISTENT"])
    assert.equal(codes({ worksiteId: "w-etranger" }).length, 1)
    const noPdf = analyzeBatch([row({ fileId: null, expectedFileName: "F-1.pdf" })], state())[0]
    assert.deepEqual([noPdf.outcome, noPdf.anomalies.map((a) => a.code)], ["IMPORT", ["PDF_MISSING"]])
  })
  it("doublon dans le lot, numéro d'une pièce Planificator, ligne exclue", () => {
    const dup = analyzeBatch([row({}), row({ number: "f 1" })], state())
    assert.deepEqual(dup.map((a) => a.outcome), ["BLOCKED", "BLOCKED"])
    assert.deepEqual(analyzeBatch([row({}), row({ number: "f 1", excluded: true })], state()).map((a) => a.outcome), ["IMPORT", "SKIP"])
    assert.equal(analyzeBatch([row({ number: "FAC-2026-0001" })], state({ native: [{ id: "n1", number: "FAC-2026-0001", kind: "INVOICE" }] }))[0].anomalies.find((a) => a.blocking)?.code, "NATIVE_NUMBER_COLLISION")
  })
  it("réimport : identique ⇒ ignoré ; identique + PDF manquant ⇒ PDF ajouté ; différent ⇒ conflit jamais écrasé", () => {
    const r = row({})
    const same = analyzeBatch([r], state({ imported: [existing(r, "c1")] }))[0]
    assert.deepEqual([same.outcome, same.anomalies.map((a) => a.code)], ["SKIP", ["ALREADY_IMPORTED"]])
    assert.equal(analyzeBatch([r], state({ imported: [existing(r, "c1", { fileId: null })] }))[0].outcome, "ATTACH")
    // Réimport sans PDF d'une pièce qui en a un : toujours « identique », jamais un conflit.
    assert.equal(analyzeBatch([row({ fileId: null })], state({ imported: [existing(r, "c1")] }))[0].outcome, "SKIP")
    const changed = row({ ttcCents: "130000", htCents: "110000" })
    const conflict = analyzeBatch([changed], state({ imported: [existing(r, "c1")] }))[0]
    assert.deepEqual([conflict.outcome, conflict.anomalies.find((a) => a.blocking)?.code, conflict.conflict?.differences.map((d) => d.field)], ["BLOCKED", "CONFLICT", ["Montant HT", "Montant TTC"]])
    assert.equal(analyzeBatch([{ ...changed, decision: "KEEP" }], state({ imported: [existing(r, "c1")] }))[0].outcome, "SKIP")
    assert.ok(!summarize([conflict]).toImport)
  })
  it("avoir : lié à une pièce importée, du lot ou Planificator ; sinon référence conservée sans lien", () => {
    const inv = row({ number: "F-10" })
    const cn = (creditedNumber: string) => row({ kind: "CREDIT_NOTE", number: "AV-1", creditedNumber })
    assert.equal(analyzeBatch([inv, cn("F 10")], state())[1].credited?.type, "BATCH")
    assert.equal(analyzeBatch([cn("F-10")], state({ imported: [existing(inv, "c1")] }))[0].credited?.type, "IMPORTED")
    assert.equal(analyzeBatch([cn("FAC-2026-0001")], state({ native: [{ id: "n1", number: "FAC-2026-0001", kind: "INVOICE" }] }))[0].credited?.type, "NATIVE")
    const orphan = analyzeBatch([cn("F-404")], state())[0]
    assert.deepEqual([orphan.outcome, orphan.credited, orphan.anomalies.some((a) => a.code === "CREDITED_NOT_FOUND" && !a.blocking)], ["IMPORT", null, true])
  })
  it("facture fournisseur : jamais importée, orientée vers le parcours existant", () => {
    const a = analyzeBatch([row({ kind: "SUPPLIER", clientName: "" })], state())[0]
    assert.deepEqual([a.outcome, a.anomalies[0].code, a.anomalies[0].blocking], ["REDIRECT", "SUPPLIER_DOCUMENT", false])
    assert.match(a.anomalies[0].message, /Factures fournisseurs/)
    assert.deepEqual(summarize([a]), { total: 1, toImport: 0, toAttach: 0, skipped: 0, blocked: 0, supplier: 1 })
  })
})
