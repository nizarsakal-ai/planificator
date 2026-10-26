// P1-01 — L'avoir total conserve la sémantique figée des lignes de déduction d'acompte (marqueur copié, comparé en SQL) ; tout
// consommateur (PDF, TVA, écritures, tableau de bord) vérifie totaux stockés = recalcul et refuse explicitement une divergence.
// Invariant : pour toute pièce émise, recalcul(lignes) = totaux persistés ; l'avoir total d'un solde remisé vaut exactement le solde.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { createCreditNoteCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { DocumentIntegrityError } from "@/lib/billing/document-integrity"
import { computeVat } from "@/lib/accounting/c5/vat"
import { accountingDashboard } from "@/lib/accounting/c5/dashboard"
import { PostingError, postInvoiceEntry, postMissingDocuments } from "@/lib/accounting/c5/postings"
import { runAccountingTransaction } from "@/lib/accounting/engine/transaction"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { getInvoiceDetail } from "@/lib/billing/invoices/invoice-queries"
import { formatEuro } from "@/lib/billing/money"
import { A, D, NOW, js, seedCompanies, sqlError, useTestClock } from "./helpers"
import { acceptedQuote, finalDraft, issue, issuedDeposit, issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const totalNote = (invoiceId: string) => db.$transaction(async (tx) => { const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId, actorId: "admA", reason: "annulation", now: NOW, nextNumber: (t) => nextDocumentNumber(t, "coA", "CREDIT_NOTE", 2026) }); if (r.ok) await flushDeferredConstraints(tx); return r })
const cents = (v: { toFixed: (n: number) => string }) => BigInt(v.toFixed(2).replace(".", ""))

before(async () => {
  useTestClock() // R3 : horloge de décision déterministe (= NOW)
  setBillingMailerForTests(new RecordingMailer())
  await seedCompanies(db)
  await db.$transaction((tx) => ensureBaseReferential(tx, A))
  await db.$transaction((tx) => openFiscalYear(tx, A, { startDate: D("2026-01-01"), endDate: D("2026-12-31") }))
})
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("P1-01 — cas de référence : prestation 100 € HT, remise globale 10 %, acompte 45 € HT, TVA 20 %", () => {
  const ids: Record<string, string> = {}
  it("solde = 45 HT + 9 TVA = 54 TTC ; avoir total = 54 TTC (jamais 59,40) ; marqueur de déduction copié ; PDF/TVA/écritures cohérents ; l'acompte n'est pas annulé", async () => {
    ids.quote = await acceptedQuote(db, A, "wA", [{ designation: "Prestation", quantity: "1", unitPrice: "100", vatRate: "20" }], { globalDiscount: "10" })
    const q = await db.quote.findUniqueOrThrow({ where: { id: ids.quote } })
    assert.equal(q.totalTTC.toFixed(2), "108.00")
    ids.dep = await issuedDeposit(db, A, ids.quote, { kind: "PERCENT", bp: 5000 })
    const dep = await db.invoice.findUniqueOrThrow({ where: { id: ids.dep } })
    assert.equal(dep.totalHT.toFixed(2), "45.00"); assert.equal(dep.totalTTC.toFixed(2), "54.00")
    ids.final = await finalDraft(db, A, ids.quote); await issue(db, A, ids.final)
    const fin = await db.invoice.findUniqueOrThrow({ where: { id: ids.final }, include: { lines: { orderBy: { position: "asc" } } } })
    assert.equal(fin.totalHT.toFixed(2), "45.00"); assert.equal(fin.totalVAT.toFixed(2), "9.00"); assert.equal(fin.totalTTC.toFixed(2), "54.00")
    assert.equal(fin.lines.filter((l) => l.deductsDepositId === ids.dep).length, 1)
    // Avoir total (chemin Lot B) : montants stockés ET recalculés = 54,00 ; la ligne de déduction porte son marqueur.
    const cn = await totalNote(ids.final); assert.ok(cn.ok, js(cn)); if (!cn.ok) return
    ids.note = cn.value.id
    const note = await db.invoice.findUniqueOrThrow({ where: { id: ids.note }, include: { lines: { orderBy: { position: "asc" } } } })
    assert.equal(note.totalTTC.toFixed(2), "54.00"); assert.equal(note.creditScope, "TOTAL")
    assert.deepEqual(note.lines.map((l) => l.deductsDepositId), fin.lines.map((l) => l.deductsDepositId))
    const pdf = await buildInvoicePdfData(db, "coA", ids.note)
    assert.equal(pdf?.totals.totalTTC, formatEuro(BigInt(5400))); assert.equal(pdf?.totals.totalHT, formatEuro(BigInt(4500)))
    // TVA sur les débits de la période : acompte +9, solde +9, avoir −9 ⇒ 9 (l'acompte reste dû, jamais annulé implicitement).
    const vat = await computeVat(db, A, D("2026-03-01"), D("2026-03-31"), "DEBITS")
    assert.equal(vat.collectedCents, BigInt(900)); assert.equal(vat.documents, 3)
    // Écritures A1 : avoir = écriture inverse exacte du solde (411 crédit 54, 706 débit 45, 44571 débit 9).
    const eFin = await runAccountingTransaction(db, (tx) => postInvoiceEntry(tx, A, ids.final))
    const eNote = await runAccountingTransaction(db, (tx) => postInvoiceEntry(tx, A, ids.note))
    const lines = async (id: string) => (await db.journalEntryLine.findMany({ where: { entryId: id }, include: { account: true } })).map((l) => [l.account.number, l.debitCents, l.creditCents].join(":")).sort()
    assert.deepEqual(await lines(eFin.entryId), ["411000:5400:0", "445710:0:900", "706000:0:4500"])
    assert.deepEqual(await lines(eNote.entryId), ["411000:0:5400", "445710:900:0", "706000:4500:0"])
    const dash = await accountingDashboard(db, A, NOW, "DEBITS")
    assert.equal(dash.revenueMonthHTCents, BigInt(4500)); assert.deepEqual(dash.inconsistentDocuments, [])
    const det = await getInvoiceDetail(db, "coA", ids.dep)
    assert.equal(det?.status, "SENT")
  })
  it("variantes : deux taux + plusieurs acomptes, remise de ligne + globale, autoliquidation, sans déduction ⇒ avoir total = pièce, recalcul = stocké", async () => {
    // Deux taux, remise de ligne et globale, deux acomptes (30 % puis montant TTC).
    const q2 = await acceptedQuote(db, A, "wA", [{ designation: "Gros œuvre", quantity: "3", unitPrice: "333.33", vatRate: "20", discount: "5" }, { designation: "Finitions", quantity: "1", unitPrice: "100.01", vatRate: "10" }], { globalDiscount: "7.5" })
    await issuedDeposit(db, A, q2, { kind: "PERCENT", bp: 3000 })
    await issuedDeposit(db, A, q2, { kind: "AMOUNT_TTC", cents: BigInt(12345) })
    const f2 = await finalDraft(db, A, q2); await issue(db, A, f2)
    const n2 = await totalNote(f2); assert.ok(n2.ok, js(n2)); if (!n2.ok) return
    for (const id of [f2, n2.value.id]) {
      const row = await db.invoice.findUniqueOrThrow({ where: { id } })
      const pdf = await buildInvoicePdfData(db, "coA", id)
      assert.equal(pdf?.totals.totalTTC, formatEuro(cents(row.totalTTC)), `${id} ${pdf?.totals.totalTTC} ≠ ${row.totalTTC}`)
    }
    // Autoliquidation : TVA nulle partout, avoir = solde.
    const q3 = await acceptedQuote(db, A, "wA", [{ designation: "Sous-traitance", quantity: "2", unitPrice: "250", vatRate: "20" }], { globalDiscount: "10", vatReverseCharge: true })
    await issuedDeposit(db, A, q3, { kind: "PERCENT", bp: 4000 })
    const f3 = await finalDraft(db, A, q3); await issue(db, A, f3)
    const r3 = await db.invoice.findUniqueOrThrow({ where: { id: f3 } })
    assert.equal(r3.totalVAT.toFixed(2), "0.00"); assert.equal(r3.totalTTC.toFixed(2), "270.00")
    const n3 = await totalNote(f3); assert.ok(n3.ok, js(n3)); if (!n3.ok) return
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: n3.value.id } })).totalTTC.toFixed(2), "270.00")
    // Sans déduction : avoir total classique inchangé.
    const plain = await issuedInvoice(db, A, "wA", [{ designation: "Seule", quantity: "1", unitPrice: "80", vatRate: "20" }])
    const n4 = await totalNote(plain); assert.ok(n4.ok, js(n4)); if (!n4.ok) return
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: n4.value.id } })).totalTTC.toFixed(2), "96.00")
    const vat = await computeVat(db, A, D("2026-03-01"), D("2026-03-31"), "DEBITS")
    for (const r of vat.collected) assert.ok(r.vatCents >= BigInt(0), js(vat))
  })
  it("solde nul (acomptes = 100 %) : soldé à l'émission ; aucune écriture, refus EXPLICITE (DOCUMENT_EMPTY) jamais masqué", async () => {
    const q = await acceptedQuote(db, A, "wA", [{ designation: "Tout", quantity: "1", unitPrice: "200", vatRate: "20" }])
    await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 10000 })
    const f = await finalDraft(db, A, q); await issue(db, A, f)
    const row = await db.invoice.findUniqueOrThrow({ where: { id: f } })
    assert.equal(row.status, "PAID"); assert.equal(row.totalTTC.toFixed(2), "0.00")
    await assert.rejects(runAccountingTransaction(db, (tx) => postInvoiceEntry(tx, A, f)), (e: unknown) => e instanceof PostingError && e.code === "DOCUMENT_EMPTY")
    const report = await postMissingDocuments(db, A)
    assert.ok(report.errors.some((e) => e.ref === row.number && /sans montant/.test(e.error)), js(report.errors))
    assert.equal(await db.accountingDocumentPosting.count({ where: { sourceId: f } }), 0)
  })
  it("SQL direct : copie d'avoir avec marqueur de déduction perdu refusée à la validation différée (CREDIT_NOTE_INVALID) ; copie fidèle acceptée ; contenu émis immuable", async () => {
    const q = await acceptedQuote(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }], { globalDiscount: "10" })
    const dep = await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 5000 })
    const f = await finalDraft(db, A, q); await issue(db, A, f)
    const fin = await db.invoice.findUniqueOrThrow({ where: { id: f }, include: { lines: { orderBy: { position: "asc" } } } })
    const copyLines = (noteId: string, keepMarker: boolean) => fin.lines.map((l, i) => `('${noteId}-l${i}','${noteId}',${l.articleId ? `'${l.articleId}'` : "NULL"},'${l.designation.replace(/'/g, "''")}',${l.description ? `'${l.description.replace(/'/g, "''")}'` : "NULL"},'${l.unit}',${l.quantity},${l.unitPrice},${l.vatRate},${l.lineHT},${l.position},${l.discountBp},${keepMarker && l.deductsDepositId ? `'${l.deductsDepositId}'` : "NULL"})`).join(",")
    const attempt = (noteId: string, keepMarker: boolean) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE invoices SET status='CANCELLED' WHERE id='${f}' AND status='SENT'`)
      await tx.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId","quoteId",number,"createdById","updatedAt",status,kind,"creditScope","creditedInvoiceId","totalHT","totalVAT","totalTTC","globalDiscountBp","vatReverseCharge") VALUES ('${noteId}','coA','wA','clA','${q}','AV-SQL-${noteId}','admA',now(),'DRAFT','CREDIT_NOTE','TOTAL','${f}',${fin.totalHT},${fin.totalVAT},${fin.totalTTC},${fin.globalDiscountBp},${fin.vatReverseCharge})`)
      await tx.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId","articleId",designation,description,unit,quantity,"unitPrice","vatRate","lineHT",position,"discountBp","deductsDepositId") VALUES ${copyLines(noteId, keepMarker)}`)
      await tx.$executeRawUnsafe(`UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='${noteId}'`)
      await flushDeferredConstraints(tx)
    })
    // La violation est détectée par le premier contrôle différé évalué (celui de l'origine annulée ou celui de l'avoir) : même invariant.
    await assert.rejects(attempt("cn-lost", false), /CREDIT_NOTE_INVALID|INVOICE_CANCEL_WITHOUT_CREDIT_NOTE/)
    assert.equal(await db.invoice.count({ where: { id: "cn-lost" } }), 0)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: f } })).status, "SENT", "rollback complet : la facture n'est pas annulée")
    await attempt("cn-kept", true)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: f } })).status, "CANCELLED")
    assert.match(await sqlError(db, `UPDATE invoice_lines SET "deductsDepositId"=NULL WHERE "invoiceId"='cn-kept'`), /INVOICE_IMMUTABLE/)
    assert.match(await sqlError(db, `UPDATE invoices SET "totalTTC"=59.40 WHERE id='cn-kept'`), /INVOICE_IMMUTABLE/)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: dep } })).status, "SENT")
  })
  it("chemin Lot B (drapeau OFF) : quantité fractionnaire 0,15 × 13,70 € — totaux du brouillon (moteur centimes) et de l'émission identiques au recalcul ; PDF, TVA et écriture acceptés ; avoir total Lot B accepté", async () => {
    const { computeTotals, computeLineHT } = await import("@/lib/billing/totals")
    const { transitionInvoiceCore } = await import("@/lib/billing/invoice-lifecycle.core")
    const line = { quantity: 0.15, unitPrice: 13.7, vatRate: 20 }
    assert.equal(computeLineHT(line), 2.06); assert.deepEqual(computeTotals([line]), { totalHT: 2.06, totalVAT: 0.41, totalTTC: 2.47 })
    await db.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"totalHT","totalVAT","totalTTC","issueDate") VALUES ('lotb-frac','coA','wA','clA','FAC-2026-0800','admA',now(),'DRAFT','INVOICE',2.05,0.41,2.46,'2026-03-10')`) // totaux flottants de l'ancien calcul
    await db.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('lotb-frac-l','lotb-frac','Main d''œuvre',0.15,13.70,20,2.05)`)
    const r = await db.$transaction(async (tx) => { const t = await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: "lotb-frac", to: "SENT", actorId: "admA", now: NOW }); await flushDeferredConstraints(tx); return t })
    assert.ok(r.ok, js(r))
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: "lotb-frac" } })
    assert.deepEqual([inv.totalHT.toFixed(2), inv.totalVAT.toFixed(2), inv.totalTTC.toFixed(2)], ["2.06", "0.41", "2.47"], "totaux recalculés à l'émission (moteur centimes)")
    const pdf = await buildInvoicePdfData(db, "coA", "lotb-frac"); assert.equal(pdf?.totals.totalTTC, formatEuro(BigInt(247)))
    const e = await runAccountingTransaction(db, (tx) => postInvoiceEntry(tx, A, "lotb-frac")); assert.equal(e.existing, false)
    const cn = await totalNote("lotb-frac"); assert.ok(cn.ok, js(cn))
  })
  it("donnée incohérente synthétique (totaux stockés ≠ lignes, pièce émise par le chemin Lot B) : PDF, TVA et écriture REFUSÉS explicitement ; tableau de bord la signale", async () => {
    await db.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"totalHT","totalVAT","totalTTC","issueDate") VALUES ('bad1','coA','wA','clA','FAC-2026-9999','admA',now(),'DRAFT','INVOICE',100,20,999,'2026-03-10')`)
    await db.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('bad1-l','bad1','Ligne',1,100,20,100)`)
    await db.$executeRawUnsafe(`UPDATE invoices SET status='SENT', "sentAt"=now() WHERE id='bad1'`)
    await assert.rejects(buildInvoicePdfData(db, "coA", "bad1"), (e: unknown) => e instanceof DocumentIntegrityError && e.documentNumber === "FAC-2026-9999")
    await assert.rejects(computeVat(db, A, D("2026-03-01"), D("2026-03-31"), "DEBITS"), (e: unknown) => e instanceof DocumentIntegrityError)
    await assert.rejects(runAccountingTransaction(db, (tx) => postInvoiceEntry(tx, A, "bad1")), (e: unknown) => e instanceof PostingError && e.code === "TOTALS_MISMATCH")
    assert.equal(await db.accountingDocumentPosting.count({ where: { sourceId: "bad1" } }), 0)
    assert.equal(await db.journalEntry.count({ where: { companyId: "coA", documentRef: "FAC-2026-9999" } }), 0, "aucune écriture partielle")
    const report = await postMissingDocuments(db, A)
    assert.ok(report.errors.some((e) => e.ref === "FAC-2026-9999" && /recalcul/.test(e.error)), js(report.errors))
    const dash = await accountingDashboard(db, A, NOW, "DEBITS")
    assert.ok(dash.inconsistentDocuments.includes("FAC-2026-9999"), js(dash.inconsistentDocuments))
    assert.ok(dash.vatWarnings.some((w) => /FAC-2026-9999/.test(w)), js(dash.vatWarnings))
    assert.equal(dash.revenueMonthHTCents > BigInt(0), true, "les autres pièces restent comptées")
  })
})
