// Lot C5 — tests PostgreSQL : écritures sourcées idempotentes (facture multi-taux, avoir, acompte, paiement, contre-passation,
// facture fournisseur), tableau de bord isolé par société, TVA débits/encaissements, FEC, banque (import, doublons, rapprochement), OCR/validation.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { verifyChain } from "@/lib/accounting/engine/posting"
import { trialBalance } from "@/lib/accounting/engine/reads"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice, recordPayment, reversePayment } from "@/lib/billing/invoices/invoice.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { postInvoiceEntry, postMissingDocuments, postPaymentEntry } from "@/lib/accounting/c5/postings"
import { runAccountingTransaction } from "@/lib/accounting/engine/transaction"
import { accountingDashboard } from "@/lib/accounting/c5/dashboard"
import { computeVat } from "@/lib/accounting/c5/vat"
import { declareVat } from "@/lib/accounting/c5/vat-declaration"
import { buildFec } from "@/lib/accounting/c5/fec"
import { autoReconcile, importBankStatement, matchTransaction } from "@/lib/accounting/c5/bank.service"
import { createSupplierInvoice, storeSupplierFile, validateSupplierInvoice, extractSupplierInvoice } from "@/lib/accounting/c5/supplier-invoice.service"
import { setOcrProviderForTests, type OcrExtraction } from "@/lib/accounting/c5/ocr-provider"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "coA", userId: "admA" }
const B = { companyId: "coB", userId: "admB" }
const now = new Date("2026-03-10T10:00:00Z")
const ids: Record<string, string> = {}
const D = (s: string) => new Date(`${s}T00:00:00Z`)
async function issued(ctx: typeof A, worksiteId: string, lines: { designation: string; quantity: string; unitPrice: string; vatRate: string }[]) {
  const p = parseInvoiceForm({ worksiteId, lines }); if (!p.ok) throw new Error(p.error)
  const d = await createDraftInvoice(db, ctx, p.value, now); if (!d.ok) throw new Error(d.error)
  const r = await issueInvoice(db, ctx, d.value.id, now); if (!r.ok) throw new Error(r.error)
  return d.value.id
}
async function balance(ctx: typeof A, number: string) {
  const fy = await db.fiscalYear.findFirstOrThrow({ where: { companyId: ctx.companyId } })
  const rows = await trialBalance(db, ctx, fy.id)
  const r = rows.find((x) => x.number === number)
  return r ? r.balanceCents : BigInt(0)
}

before(async () => {
  // Le rapprochement avec une facture client enregistre un paiement C2 : il exige la facturation complète (drapeau).
  process.env.BILLING_COMPLETE_ENABLED = "true"
  setBillingMailerForTests(new RecordingMailer())
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('coA','Société A','a','12345678900012','1 rue A',now()),('coB','Société B','b','98765432100011','2 rue B',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('admA','a@x','x','ADMIN','coA',now()),('admB','b@x','x','ADMIN','coB',now())`)
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,email,address,"updatedAt") VALUES ('clA','coA','Client A','client-a@example.test','10 rue',now()),('clB','coB','Client B','client-b@example.test','11 rue',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','admA','Maison A',now()),('wB','coB','clB','admB','Maison B',now())`)
  for (const ctx of [A, B]) {
    await db.$transaction((tx) => ensureBaseReferential(tx, ctx))
    await db.$transaction((tx) => openFiscalYear(tx, ctx, { startDate: D("2026-01-01"), endDate: D("2026-12-31") }))
  }
})
after(async () => { setBillingMailerForTests(null); setOcrProviderForTests(null); await db.$disconnect() })

describe("Écritures depuis les pièces", () => {
  it("facture multi-taux ⇒ écriture VT équilibrée validée (411 = 706 + 44571 par taux) ; régénération idempotente ; société B refusée", async () => {
    ids.inv = await issued(A, "wA", [{ designation: "Pose", quantity: "1", unitPrice: "1000", vatRate: "20" }, { designation: "Finitions", quantity: "1", unitPrice: "100", vatRate: "10" }])
    const r1 = await runAccountingTransaction(db, (tx) => postInvoiceEntry(tx, A, ids.inv))
    assert.equal(r1.existing, false)
    const r2 = await runAccountingTransaction(db, (tx) => postInvoiceEntry(tx, A, ids.inv))
    assert.deepEqual(r2, { entryId: r1.entryId, existing: true })
    const e = await db.journalEntry.findUniqueOrThrow({ where: { id: r1.entryId }, include: { lines: { include: { account: true } } } })
    assert.equal(e.status, "VALIDATED"); assert.equal(e.sourceType, "INVOICE"); assert.equal(e.documentRef, "FAC-2026-0001")
    const by = (n: string) => e.lines.filter((l) => l.account.number === n)
    assert.equal(by("411000")[0].debitCents, BigInt(131000)); assert.equal(by("706000").reduce((s, l) => s + l.creditCents, BigInt(0)), BigInt(110000)); assert.equal(by("445710").reduce((s, l) => s + l.creditCents, BigInt(0)), BigInt(21000))
    assert.deepEqual(by("445710").map((l) => l.vatRateBp).sort(), [1000, 2000])
    await assert.rejects(runAccountingTransaction(db, (tx) => postInvoiceEntry(tx, B, ids.inv)), /DOCUMENT_NOT_FOUND/)
    assert.equal(await db.journalEntry.count({ where: { companyId: "coA" } }), 1)
  })
  it("paiement ⇒ BQ (512/411) ; contre-passation ⇒ écriture inverse ; avoir partiel ⇒ VT inverse ; génération en lot sans doublon", async () => {
    const p = await recordPayment(db, A, ids.inv, { amountCents: BigInt(31000), method: "TRANSFER", paidAt: now, reference: null, notes: null }, now)
    assert.ok(p.ok); if (!p.ok) return
    const pe = await runAccountingTransaction(db, (tx) => postPaymentEntry(tx, A, p.value.paymentId))
    const e = await db.journalEntry.findUniqueOrThrow({ where: { id: pe.entryId }, include: { lines: { include: { account: true } }, journal: true } })
    assert.equal(e.journal.code, "BQ"); assert.equal(e.lines.find((l) => l.account.number === "512000")?.debitCents, BigInt(31000)); assert.equal(e.lines.find((l) => l.account.number === "411000")?.creditCents, BigInt(31000))
    assert.ok((await reversePayment(db, A, p.value.paymentId, "erreur", now)).ok)
    const line = await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: ids.inv, designation: "Finitions" } })
    const cn = await createPartialCreditNote(db, A, ids.inv, { kind: "LINES", items: [{ lineId: line.id, quantityHundredths: BigInt(100) }] }, "geste commercial", now)
    assert.ok(cn.ok)
    const report = await postMissingDocuments(db, A)
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors)); assert.equal(report.posted, 2) // contre-passation + avoir
    const again = await postMissingDocuments(db, A)
    assert.equal(again.posted, 0); assert.equal(again.existing, 4)
    assert.equal(await balance(A, "411000"), BigInt(131000 - 11000)) // 1 310 − avoir 110 ; paiement annulé
    assert.equal(await balance(A, "512000"), BigInt(0))
    const vt = await db.accountingJournal.findFirstOrThrow({ where: { companyId: "coA", code: "VT" } })
    assert.deepEqual(await db.$transaction((tx) => verifyChain(tx, A, vt.id)), { ok: true, checked: 2 })
  })
})

describe("Tableau de bord, TVA, FEC", () => {
  it("tableau de bord : société A seulement ; B n'y voit rien", async () => {
    await issued(B, "wB", [{ designation: "B", quantity: "1", unitPrice: "500", vatRate: "20" }])
    const a = await accountingDashboard(db, A, now, "DEBITS")
    const b = await accountingDashboard(db, B, now, "DEBITS")
    assert.equal(a.revenueMonthHTCents, BigInt(110000 - 10000)); assert.equal(a.revenueYearHTCents, a.revenueMonthHTCents); assert.equal(a.unpaid.count, 1)
    assert.equal(b.revenueMonthHTCents, BigInt(50000)); assert.equal(b.unpaid.count, 1)
    assert.equal(a.revenue12Months.length, 12); assert.equal(a.revenue12Months.at(-1)?.htCents, a.revenueMonthHTCents)
  })
  it("TVA : débits (pièces émises, avoir déduit) vs encaissements (prorata des paiements) ; déclaration unique par période", async () => {
    const d = await computeVat(db, A, D("2026-03-01"), D("2026-03-31"), "DEBITS")
    assert.equal(d.collectedCents, BigInt(21000 - 1000)); assert.deepEqual(d.collected.map((r) => [r.vatRateBp, r.vatCents]), [[1000, BigInt(0)], [2000, BigInt(20000)]])
    const p = await recordPayment(db, A, ids.inv, { amountCents: BigInt(60000), method: "CHECK", paidAt: now, reference: null, notes: null }, now)
    assert.ok(p.ok)
    const e = await computeVat(db, A, D("2026-03-01"), D("2026-03-31"), "ENCAISSEMENTS")
    // Paiements de la période : +31 000 −31 000 +60 000 = 60 000 sur TTC 131 000 ⇒ TVA ≈ 60 000 × 21 000 / 131 000 = 9 618 ; moins l'avoir émis (TVA 1 000) ⇒ ≈ 8 618
    assert.ok(e.collectedCents > BigInt(8500) && e.collectedCents < BigInt(8700), String(e.collectedCents)); assert.equal(e.payments, 3); assert.equal(e.documents, 1)
    const decl = await declareVat(db, A, D("2026-03-01"), D("2026-03-31"), "DEBITS")
    assert.ok(decl.ok && decl.value.dueCents === BigInt(20000))
    assert.equal((await declareVat(db, A, D("2026-03-01"), D("2026-03-31"), "DEBITS")).ok, false)
    assert.equal(await db.vatDeclaration.count({ where: { companyId: "coB" } }), 0)
  })
  it("FEC : 18 colonnes, écritures validées seulement, ordre chronologique, nom SIRENFECAAAAMMJJ.txt, équilibré", async () => {
    const fy = await db.fiscalYear.findFirstOrThrow({ where: { companyId: "coA" } })
    const fec = await buildFec(db, A, fy.id)
    assert.ok(fec); if (!fec) return
    assert.equal(fec.filename, "123456789FEC20261231.txt"); assert.equal(fec.sirenMissing, false)
    const rows = fec.content.trim().split("\r\n")
    assert.equal(rows[0].split("|").length, 18); assert.ok(rows.every((r) => r.split("|").length === 18)); assert.equal(fec.debitCents, fec.creditCents); assert.equal(fec.lines, await db.journalEntryLine.count({ where: { companyId: "coA", entry: { status: "VALIDATED" } } }))
    assert.ok(rows.some((r) => r.startsWith("VT|Ventes|1|20260310|411000|Clients|||FAC-2026-0001|20260310|")), rows.slice(0, 4).join("\n"))
    assert.ok(rows.slice(1).every((r, i, a) => i === 0 || a[i - 1].split("|")[3] <= r.split("|")[3]), "ordre chronologique")
    assert.equal(await buildFec(db, B, fy.id), null)
  })
})

describe("Banque et factures fournisseurs", () => {
  it("import CSV : relevé unique (sha256), lignes uniques (empreinte) ; rapprochement auto ⇒ paiement unique ; manuel plafonné ; B isolée", async () => {
    const open = await issued(A, "wA", [{ designation: "Ouverte", quantity: "1", unitPrice: "200", vatRate: "20" }])
    const csv = `Date;Libellé;Montant;Référence\n12/03/2026;VIR CLIENT ${(await db.invoice.findUniqueOrThrow({ where: { id: open } })).number};240,00;X1\n12/03/2026;VIR INCONNU;99,99;X2\n13/03/2026;PRLV FOURNISSEUR;-300,00;X3\n`
    const m = { date: 0, label: 1, amount: 2, reference: 3, headerRows: 1 }
    const i1 = await importBankStatement(db, A, csv, "releve.csv", m)
    assert.ok(i1.ok && i1.value.imported === 3)
    assert.deepEqual(await importBankStatement(db, A, csv, "releve.csv", m), { ok: false, error: "Ce relevé a déjà été importé." })
    const i2 = await importBankStatement(db, A, csv + "14/03/2026;AUTRE;1,00;X4\n", "releve2.csv", m)
    assert.ok(i2.ok && i2.value.imported === 1 && i2.value.duplicates === 3)
    delete process.env.BILLING_COMPLETE_ENABLED
    const off = await autoReconcile(db, A)
    assert.equal(off.matched, 0, "sans drapeau C2 : aucun paiement créé par le rapprochement")
    process.env.BILLING_COMPLETE_ENABLED = "true"
    const r = await autoReconcile(db, A)
    assert.equal(r.matched, 1); assert.equal(await db.invoicePayment.count({ where: { invoiceId: open } }), 1)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: open } })).status, "PAID")
    const again = await autoReconcile(db, A); assert.equal(again.matched, 0)
    const pending = await db.bankTransaction.findFirstOrThrow({ where: { companyId: "coA", status: "PENDING", amountCents: BigInt(9999) } })
    const manual = await matchTransaction(db, A, pending.id, { invoiceId: ids.inv })
    assert.equal(manual.ok, true)
    assert.equal(await db.bankTransaction.count({ where: { companyId: "coB" } }), 0)
    assert.deepEqual(await matchTransaction(db, B, pending.id, { ignore: true }), { ok: false, error: "Opération bancaire introuvable." })
  })
  it("facture fournisseur : fichier (signature, doublon), OCR injecté, validation idempotente ⇒ fournisseur par SIRET + écriture HA ; rapprochement débit", async () => {
    const fake: OcrExtraction = { supplier: "Fournisseur Z", siret: "11111111100011", invoiceNumber: "FZ-1", date: "2026-03-05", totalHTCents: BigInt(25000), vatCents: BigInt(5000), totalTTCCents: BigInt(30000), vatRateBp: 2000, category: "services", confidence: { supplier: 0.9 }, amountsAdjusted: false, rawText: "{}" }
    setOcrProviderForTests({ name: "fake", extract: async () => fake })
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png")])
    assert.equal((await storeSupplierFile(db, A, Buffer.from("GIF89a..."), "x.gif")).ok, false)
    const f = await storeSupplierFile(db, A, png, "facture.png"); assert.ok(f.ok); if (!f.ok) return
    // Même fichier non encore rattaché à une facture (formulaire abandonné) : réutilisé, pas de blocage.
    const again = await storeSupplierFile(db, A, png, "facture.png")
    assert.ok(again.ok && again.value.duplicate && again.value.fileId === f.value.fileId)
    const ocr = await extractSupplierInvoice(db, A, f.value.fileId); assert.ok(ocr.ok)
    assert.equal((await extractSupplierInvoice(db, B, f.value.fileId)).ok, false)
    const c = await createSupplierInvoice(db, A, { supplierName: fake.supplier!, siret: fake.siret, number: "FZ-1", date: D("2026-03-05"), dueDate: null, totalHTCents: BigInt(25000), vatCents: BigInt(5000), totalTTCCents: BigInt(30000), vatRateBp: 2000, category: "services", expenseAccountId: null, notes: null }, { fileId: f.value.fileId, ocr: fake })
    assert.ok(c.ok); if (!c.ok) return
    assert.deepEqual(await storeSupplierFile(db, A, png, "facture.png"), { ok: false, error: "Ce fichier a déjà été importé." })
    assert.equal((await createSupplierInvoice(db, A, { supplierName: "x", siret: null, number: "n", date: now, dueDate: null, totalHTCents: BigInt(1), vatCents: BigInt(1), totalTTCCents: BigInt(3), vatRateBp: null, category: null, expenseAccountId: null, notes: null }, { fileId: null, ocr: null })).ok, false)
    const v1 = await validateSupplierInvoice(db, A, c.value.id); assert.ok(v1.ok); if (!v1.ok) return
    const v2 = await validateSupplierInvoice(db, A, c.value.id); assert.deepEqual(v2, v1)
    assert.equal(await db.supplier.count({ where: { companyId: "coA", siret: "11111111100011" } }), 1)
    const e = await db.journalEntry.findUniqueOrThrow({ where: { id: v1.value.entryId }, include: { lines: { include: { account: true } }, journal: true } })
    assert.equal(e.journal.code, "HA"); assert.equal(e.lines.find((l) => l.account.number === "604000")?.debitCents, BigInt(25000)); assert.equal(e.lines.find((l) => l.account.number === "445660")?.debitCents, BigInt(5000)); assert.equal(e.lines.find((l) => l.account.number === "401000")?.creditCents, BigInt(30000))
    assert.equal(await validateSupplierInvoice(db, B, c.value.id).then((r) => r.ok), false)
    const ded = await computeVat(db, A, D("2026-03-01"), D("2026-03-31"), "DEBITS")
    assert.equal(ded.deductibleCents, BigInt(5000))
    const prlv = await db.bankTransaction.findFirstOrThrow({ where: { companyId: "coA", status: "PENDING", amountCents: BigInt(-30000) } })
    assert.equal((await matchTransaction(db, A, prlv.id, { supplierInvoiceId: c.value.id })).ok, true)
    assert.ok((await db.supplierInvoice.findUniqueOrThrow({ where: { id: c.value.id } })).paidAt)
  })
})
