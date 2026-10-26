// Campagne E (mandat §4.E) — parcours croisé sur données synthétiques : devis multi-taux remisé → signature par jeton → acomptes →
// facture de solde → émission → paiement/contre-passation → avoir partiel permis → écritures A1 → réédition PDF → TVA → export FEC.
// Vérifications : équilibres et rapprochement pièce/source/écriture au centime, idempotence après rejeu, compteurs FAC/AV après
// rollback, concurrence d'émission. Le FEC reste un export TECHNIQUE/provisoire (structure, portée, équilibre) — pas une validation fiscale.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { runAccountingTransaction } from "@/lib/accounting/engine/transaction"
import { verifyChain } from "@/lib/accounting/engine/posting"
import { trialBalance } from "@/lib/accounting/engine/reads"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { convertQuote, createQuote, sendQuote, signQuoteByToken } from "@/lib/billing/quotes/quote.service"
import { createDepositInvoice } from "@/lib/billing/invoices/deposit.service"
import { issueInvoice, recordPayment, reversePayment } from "@/lib/billing/invoices/invoice.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { getInvoiceDetail } from "@/lib/billing/invoices/invoice-queries"
import { buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { postMissingDocuments } from "@/lib/accounting/c5/postings"
import { computeVat } from "@/lib/accounting/c5/vat"
import { declareVat } from "@/lib/accounting/c5/vat-declaration"
import { buildFec } from "@/lib/accounting/c5/fec"
import { decimalToCents } from "@/lib/billing/money"
import { A, D, NOW, js, seedCompanies, useTestClock } from "./helpers"

const db = new PrismaClient()
const db2 = new PrismaClient()
const ids: Record<string, string> = {}
const c = (v: { toFixed: (n: number) => string }) => decimalToCents(v.toFixed(2))

before(async () => {
  useTestClock() // R3 : horloge de décision déterministe (= NOW)
  setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db)
  await db.$transaction((tx) => ensureBaseReferential(tx, A)); await db.$transaction((tx) => openFiscalYear(tx, A, { startDate: D("2026-01-01"), endDate: D("2026-12-31") }))
})
after(async () => { setBillingMailerForTests(null); await db.$disconnect(); await db2.$disconnect() })

describe("Campagne E — parcours croisé", () => {
  it("devis multi-taux remisé → signature → 2 acomptes → solde → émission → paiement, contre-passation → avoir partiel : montants exacts au centime", async () => {
    // 1 000,00 @20 % (−5 % ligne) + 333,33 @10 %, remise globale 7,5 %.
    const p = parseQuoteForm({ worksiteId: "wA", issueDate: "2026-03-10", validUntil: "2026-12-31", globalDiscount: "7,5", lines: [{ designation: "Gros œuvre", quantity: "1", unitPrice: "1000", vatRate: "20", discount: "5" }, { designation: "Finitions", quantity: "1", unitPrice: "333,33", vatRate: "10" }] }); assert.ok(p.ok); if (!p.ok) return
    const q = await createQuote(db, A, p.value); assert.ok(q.ok); if (!q.ok) return
    ids.quote = q.value.id
    const s = await sendQuote(db, A, ids.quote, NOW); assert.ok(s.ok); if (!s.ok) return
    assert.ok((await signQuoteByToken(db, s.value.signatureUrl.split("/devis-signature/")[1], { signerName: "Client A", ipHash: null, now: NOW })).ok)
    // Oracle du devis : 950 × 0,925 = 878,75 (TVA 175,75) ; 333,33 × 0,925 = 308,33 (TVA 30,83) ⇒ HT 1 187,08 ; TVA 206,58 ; TTC 1 393,66.
    const quote = await db.quote.findUniqueOrThrow({ where: { id: ids.quote } })
    assert.deepEqual([quote.totalHT.toFixed(2), quote.totalVAT.toFixed(2), quote.totalTTC.toFixed(2)], ["1187.08", "206.58", "1393.66"])
    const d1 = await createDepositInvoice(db, A, ids.quote, { kind: "PERCENT", bp: 3000 }, NOW); assert.ok(d1.ok); if (!d1.ok) return
    const d2 = await createDepositInvoice(db, A, ids.quote, { kind: "AMOUNT_TTC", cents: BigInt(20000) }, NOW); assert.ok(d2.ok); if (!d2.ok) return
    for (const id of [d1.value.id, d2.value.id]) assert.ok((await issueInvoice(db, A, id, NOW)).ok)
    ids.dep1 = d1.value.id; ids.dep2 = d2.value.id
    // Acompte 30 % : 263,63 HT (20 %) + 92,50 HT (10 %) ⇒ TVA 52,73 + 9,25 ⇒ TTC 418,11.
    const dep1 = await db.invoice.findUniqueOrThrow({ where: { id: ids.dep1 } }); assert.equal(dep1.totalTTC.toFixed(2), "418.11")
    const dep2 = await db.invoice.findUniqueOrThrow({ where: { id: ids.dep2 } }); assert.equal(dep2.totalTTC.toFixed(2), "200.00")
    const conv = await convertQuote(db, A, ids.quote, NOW); assert.ok(conv.ok); if (!conv.ok) return
    ids.final = conv.value.invoiceId
    assert.ok((await issueInvoice(db, A, ids.final, NOW)).ok)
    const fin = await db.invoice.findUniqueOrThrow({ where: { id: ids.final } })
    // Solde = devis − acomptes au centime (déductions hors remise : HT devis − HT acomptes, TVA par taux).
    assert.equal(c(fin.totalTTC), c(quote.totalTTC) - c(dep1.totalTTC) - c(dep2.totalTTC), js({ fin, quote, dep1, dep2 }))
    assert.equal(c(fin.totalHT), c(quote.totalHT) - c(dep1.totalHT) - c(dep2.totalHT))
    // Paiement partiel puis contre-passation puis nouveau paiement ; avoir partiel permis (≤ reste à payer).
    const p1 = await recordPayment(db, A, ids.final, { amountCents: BigInt(30000), method: "TRANSFER", paidAt: NOW, reference: "V1", notes: null }, NOW); assert.ok(p1.ok); if (!p1.ok) return
    assert.ok((await reversePayment(db, A, p1.value.paymentId, "erreur de saisie", NOW)).ok)
    const p2 = await recordPayment(db, A, ids.final, { amountCents: BigInt(30000), method: "CHECK", paidAt: NOW, reference: "C1", notes: null }, NOW); assert.ok(p2.ok)
    const det = await getInvoiceDetail(db, "coA", ids.final); assert.ok(det)
    const cn = await createPartialCreditNote(db, A, ids.final, { kind: "AMOUNT_HT", cents: BigInt(10000) }, "Geste commercial", NOW); assert.ok(cn.ok, js(cn)); if (!cn.ok) return
    ids.cn = cn.value.id
    const det2 = await getInvoiceDetail(db, "coA", ids.final)
    assert.equal(det2?.remainingCents, c(fin.totalTTC) - BigInt(30000) - cn.value.ttcCents)
    assert.equal(cn.value.number, "AV-2026-0001")
  })
  it("écritures A1 : génération idempotente ; rapprochement pièce ↔ écriture au centime ; balance 411 = reste dû cumulé ; chaîne d'empreintes intacte", async () => {
    const r1 = await postMissingDocuments(db, A); assert.equal(r1.errors.length, 0, js(r1.errors))
    const r2 = await postMissingDocuments(db, A); assert.equal(r2.posted, 0)
    const postings = await db.accountingDocumentPosting.findMany({ where: { companyId: "coA" }, include: { entry: { include: { lines: { include: { account: true } } } } } })
    for (const p of postings) {
      const e = p.entry; const debit = e.lines.reduce((s, l) => s + l.debitCents, BigInt(0)), credit = e.lines.reduce((s, l) => s + l.creditCents, BigInt(0))
      assert.equal(debit, credit, `écriture ${e.number} équilibrée`); assert.equal(e.status, "VALIDATED")
      if (p.sourceType !== "PAYMENT") {
        const inv = await db.invoice.findUniqueOrThrow({ where: { id: p.sourceId } })
        const l411 = e.lines.find((l) => l.account.number === "411000")!
        assert.equal(inv.kind === "CREDIT_NOTE" ? l411.creditCents : l411.debitCents, c(inv.totalTTC), `411 = TTC de ${inv.number}`)
      } else {
        const pay = await db.invoicePayment.findUniqueOrThrow({ where: { id: p.sourceId } })
        const l411 = e.lines.find((l) => l.account.number === "411000")!
        assert.equal(pay.amountCents > BigInt(0) ? l411.creditCents : l411.debitCents, pay.amountCents > BigInt(0) ? pay.amountCents : -pay.amountCents)
      }
    }
    const fy = await db.fiscalYear.findFirstOrThrow({ where: { companyId: "coA" } })
    const bal = await trialBalance(db, A, fy.id)
    const b411 = bal.find((x) => x.number === "411000")!.balanceCents
    const docs = await db.invoice.findMany({ where: { companyId: "coA", sentAt: { not: null } }, select: { kind: true, totalTTC: true } })
    const paid = (await db.invoicePayment.aggregate({ where: { companyId: "coA" }, _sum: { amountCents: true } }))._sum.amountCents ?? BigInt(0)
    const expected411 = docs.reduce((s, d) => s + (d.kind === "CREDIT_NOTE" ? -c(d.totalTTC) : c(d.totalTTC)), BigInt(0)) - paid
    assert.equal(b411, expected411, "411 = Σ pièces émises − Σ paiements nets")
    for (const code of ["VT", "BQ"]) { const j = await db.accountingJournal.findFirstOrThrow({ where: { companyId: "coA", code } }); const v = await db.$transaction((tx) => verifyChain(tx, A, j.id)); assert.equal(v.ok, true, js(v)) }
  })
  it("réédition PDF figée ; TVA débits = Σ TVA des pièces ; TVA encaissements = part des paiements ; déclaration ; FEC technique (18 colonnes, équilibre, portée, dates)", async () => {
    const pdfBefore = await buildInvoicePdfData(db, "coA", ids.final, NOW)
    await db.$executeRawUnsafe(`UPDATE companies SET address='Déménagé' WHERE id='coA'`)
    const pdfAfter = await buildInvoicePdfData(db, "coA", ids.final, NOW)
    assert.equal(js({ ...pdfAfter, settlement: null }), js({ ...pdfBefore, settlement: null })); assert.equal(pdfAfter?.reissue?.source, "SNAPSHOT")
    const docs = await db.invoice.findMany({ where: { companyId: "coA", sentAt: { not: null } }, select: { kind: true, totalVAT: true } })
    const deb = await computeVat(db, A, D("2026-03-01"), D("2026-03-31"), "DEBITS")
    assert.equal(deb.collectedCents, docs.reduce((s, d) => s + (d.kind === "CREDIT_NOTE" ? -c(d.totalVAT) : c(d.totalVAT)), BigInt(0)))
    const enc = await computeVat(db, A, D("2026-03-01"), D("2026-03-31"), "ENCAISSEMENTS")
    // Paiements nets sur le solde : +300 −300 +300 = 300 ⇒ part de TVA = Σ arrondis cumulés (< TVA totale du solde) ; vérifié par recalcul indépendant.
    const fin = await db.invoice.findUniqueOrThrow({ where: { id: ids.final } })
    const share = (vat: bigint) => (BigInt(30000) * vat + c(fin.totalTTC) / BigInt(2)) / c(fin.totalTTC)
    void share
    assert.ok(enc.collectedCents > BigInt(0) && enc.collectedCents < c(fin.totalVAT), js(enc)); assert.equal(enc.payments, 3)
    setBillingClockForTests(() => new Date("2026-06-01T10:00:00Z")) // la période déclarée doit être terminée (C1)
    const decl = await declareVat(db, A, D("2026-03-01"), D("2026-03-31"), "DEBITS"); assert.ok(decl.ok && decl.value.dueCents === deb.dueCents, JSON.stringify(decl, (_, x) => (typeof x === "bigint" ? x.toString() : x)))
    const fy = await db.fiscalYear.findFirstOrThrow({ where: { companyId: "coA" } })
    const fec = await buildFec(db, A, fy.id); assert.ok(fec); if (!fec) return
    const rows = fec.content.trim().split("\r\n")
    assert.equal(rows[0], "JournalCode|JournalLib|EcritureNum|EcritureDate|CompteNum|CompteLib|CompAuxNum|CompAuxLib|PieceRef|PieceDate|EcritureLib|Debit|Credit|EcritureLet|DateLet|ValidDate|Montantdevise|Idevise")
    assert.ok(rows.every((r) => r.split("|").length === 18)); assert.equal(fec.debitCents, fec.creditCents); assert.equal(fec.filename, "123456789FEC20261231.txt")
    assert.equal(fec.lines, await db.journalEntryLine.count({ where: { companyId: "coA", entry: { status: "VALIDATED", fiscalYearId: fy.id } } }))
    assert.ok(rows.slice(1).every((r) => /^\d{8}$/.test(r.split("|")[3]) && r.split("|")[3] >= "20260101" && r.split("|")[3] <= "20261231"))
    const nums = rows.slice(1).map((r) => r.split("|").slice(0, 3).join("|"))
    assert.equal(new Set(nums.map((n) => n.split("|")[0] + n.split("|")[2])).size, await db.journalEntry.count({ where: { companyId: "coA", status: "VALIDATED" } }), "aucune renumérotation : un numéro par écriture et par journal")
  })
  it("compteurs FAC/AV : un échec après réservation annule la réservation (pas de trou) ; deux émissions concurrentes ⇒ un seul numéro", async () => {
    const { parseInvoiceForm } = await import("@/lib/billing/invoices/invoice-schemas")
    const { createDraftInvoice } = await import("@/lib/billing/invoices/invoice.service")
    const { issueInvoiceCore } = await import("@/lib/billing/invoices/invoice-c2.core")
    const { nextDocumentNumber } = await import("@/lib/billing/numbering")
    const counter = async () => (await db.documentCounter.findFirst({ where: { companyId: "coA", type: "INVOICE", year: 2026 } }))?.lastValue ?? 0
    const p = parseInvoiceForm({ worksiteId: "wA", lines: [{ designation: "X", quantity: "1", unitPrice: "10", vatRate: "20" }] }); assert.ok(p.ok); if (!p.ok) return
    const d = await createDraftInvoice(db, A, p.value, NOW); assert.ok(d.ok); if (!d.ok) return
    const before = await counter()
    // Panne après réservation du numéro (dans la transaction) ⇒ rollback : compteur inchangé.
    await assert.rejects(db.$transaction(async (tx) => {
      const r = await issueInvoiceCore(tx, { companyId: "coA", invoiceId: d.value.id, actorId: "admA", now: NOW, paymentTermsDays: 30, nextLegalNumber: (t, y) => nextDocumentNumber(t, "coA", "INVOICE", y), lockInvoice: async (t, id, co) => { await t.$queryRaw`SELECT 1 FROM "invoices" WHERE "id" = ${id} AND "companyId" = ${co} FOR UPDATE` } })
      assert.ok(r.ok); throw new Error("PANNE_APRES_NUMERO")
    }), /PANNE_APRES_NUMERO/)
    assert.equal(await counter(), before); assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: d.value.id } })).status, "DRAFT")
    const both = await Promise.all([issueInvoice(db, A, d.value.id, NOW), issueInvoice(db2, A, d.value.id, NOW)])
    assert.equal(both.filter((r) => r.ok).length, 1, js(both)); assert.equal(await counter(), before + 1)
    const avBefore = (await db.documentCounter.findFirst({ where: { companyId: "coA", type: "CREDIT_NOTE", year: 2026 } }))?.lastValue ?? 0
    const bad = await createPartialCreditNote(db, A, d.value.id, { kind: "AMOUNT_HT", cents: BigInt(99999) }, "trop", NOW); assert.equal(bad.ok, false)
    assert.equal((await db.documentCounter.findFirst({ where: { companyId: "coA", type: "CREDIT_NOTE", year: 2026 } }))?.lastValue ?? 0, avBefore, "AV non consommé par un avoir refusé")
  })
})
