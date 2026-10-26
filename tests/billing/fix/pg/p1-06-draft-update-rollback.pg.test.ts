// P1-06 — Un refus de recalcul des déductions après remplacement des lignes d'un brouillon de solde n'a AUCUN effet persistant :
// en-tête, lignes, liaisons et journal strictement identiques (ROLLBACK). Invariant : réponse { ok: false } ⇒ état métier inchangé.
// Concurrence (deux connexions, barrières) : une émission concurrente ne permet jamais un remplacement de lignes après émission.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { issueInvoice, updateDraftInvoice } from "@/lib/billing/invoices/invoice.service"
import { issueInvoiceCore, replaceInvoiceDraftCore } from "@/lib/billing/invoices/invoice-c2.core"
import { DEPOSIT_ERRORS, depositIssueChecks } from "@/lib/billing/invoices/deposit.service"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { A, NOW, holdTransaction, js, seedCompanies, waitFor, waitingSessions, useTestClock } from "./helpers"
import { acceptedQuote, finalDraft, issuedDeposit } from "./fixtures"

const db = new PrismaClient()
const db2 = new PrismaClient() // connexion indépendante
const lines = (designation: string, unitPrice: string, vatRate = "20") => [{ designation, quantity: "1", unitPrice, vatRate }]
const form = (quoteId: string, l: ReturnType<typeof lines>, globalDiscount = "") => { const p = parseInvoiceForm({ worksiteId: "wA", quoteId, lines: l, globalDiscount }); if (!p.ok) throw new Error(p.error); return p.value }

async function snapshot(invoiceId: string) {
  const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
  const ls = await db.invoiceLine.findMany({ where: { invoiceId }, orderBy: { position: "asc" } })
  const ded = await db.invoiceDepositDeduction.findMany({ where: { finalInvoiceId: invoiceId }, orderBy: { depositInvoiceId: "asc" } })
  const hist = await db.historyLog.findMany({ where: { entityId: invoiceId }, orderBy: { createdAt: "asc" }, select: { id: true, action: true, detail: true } })
  const counters = await db.documentCounter.findMany({ where: { companyId: "coA" }, orderBy: [{ type: "asc" }, { year: "asc" }] })
  return js({ inv: { ...inv, updatedAt: undefined }, ls, ded, hist, counters })
}

before(async () => { useTestClock(); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); await db.$disconnect(); await db2.$disconnect() })

describe("P1-06 — modification refusée d'une facture de solde", () => {
  it("prestations ramenées sous les acomptes émis ⇒ refus (plafond) et état métier/audit strictement identique ; modification valide ⇒ déductions régénérées", async () => {
    const quote = await acceptedQuote(db, A, "wA", lines("Travaux", "1000"))
    const dep = await issuedDeposit(db, A, quote, { kind: "PERCENT", bp: 6000 }) // 600 HT déduits
    const fin = await finalDraft(db, A, quote)
    const before = await snapshot(fin)
    assert.match(before, /Déduction acompte/)
    const r = await updateDraftInvoice(db, A, fin, form(quote, lines("Travaux réduits", "100")))
    assert.deepEqual(r, { ok: false, error: DEPOSIT_ERRORS.ceiling })
    assert.equal(await snapshot(fin), before, "aucune mutation persistée après le refus (en-tête, lignes, liaisons, journal, compteurs)")
    assert.equal((await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: fin, deductsDepositId: null } })).designation, "Travaux")
    // Modification valide : lignes remplacées, déductions régénérées, totaux exacts (800 − 600 = 200 HT ⇒ 240 TTC).
    const ok = await updateDraftInvoice(db, A, fin, form(quote, lines("Travaux ajustés", "800")))
    assert.deepEqual(ok, { ok: true, value: undefined })
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: fin }, include: { lines: true } })
    assert.equal(inv.totalTTC.toFixed(2), "240.00"); assert.equal(inv.lines.filter((l) => l.deductsDepositId === dep).length, 1); assert.equal(inv.lines.find((l) => !l.deductsDepositId)?.designation, "Travaux ajustés")
    assert.equal(await db.invoiceDepositDeduction.count({ where: { finalInvoiceId: fin } }), 1)
  })
  it("variante deux taux et deux acomptes : refus sans effet ; puis la même modification sous une facture déjà émise ⇒ refus explicite", async () => {
    const quote = await acceptedQuote(db, A, "wA", [{ designation: "GO", quantity: "1", unitPrice: "1000", vatRate: "20" }, { designation: "Fin", quantity: "1", unitPrice: "500", vatRate: "10" }], { globalDiscount: "5" })
    await issuedDeposit(db, A, quote, { kind: "PERCENT", bp: 3000 })
    await issuedDeposit(db, A, quote, { kind: "AMOUNT_TTC", cents: BigInt(50000) })
    const fin = await finalDraft(db, A, quote)
    const before = await snapshot(fin)
    const r = await updateDraftInvoice(db, A, fin, form(quote, [{ designation: "GO", quantity: "1", unitPrice: "100", vatRate: "20" }], "5"))
    assert.deepEqual(r, { ok: false, error: DEPOSIT_ERRORS.ceiling })
    assert.equal(await snapshot(fin), before)
    assert.ok((await issueInvoice(db, A, fin, NOW)).ok)
    const after = await snapshot(fin)
    const r2 = await updateDraftInvoice(db, A, fin, form(quote, [{ designation: "GO", quantity: "1", unitPrice: "900", vatRate: "20" }], "5"))
    assert.equal(r2.ok, false); assert.match((r2 as { error: string }).error, /brouillon/)
    assert.equal(await snapshot(fin), after)
  })
  it("concurrence (2 connexions) : émission en cours ⇒ la modification attend puis est refusée ; modification en cours ⇒ l'émission attend puis porte sur les lignes finales", async () => {
    // A. T1 (db2) émet dans une transaction tenue ouverte ; T2 (db) tente de modifier : bloquée sur le verrou de ligne, puis refusée.
    const quote = await acceptedQuote(db, A, "wA", lines("Chantier", "1000"))
    await issuedDeposit(db, A, quote, { kind: "PERCENT", bp: 1000 })
    const fin = await finalDraft(db, A, quote)
    const t1 = await holdTransaction(db2)
    const issued = await issueInvoiceCore(t1.tx, { companyId: "coA", invoiceId: fin, actorId: "admA", now: NOW, paymentTermsDays: 30, nextLegalNumber: (t, y) => nextDocumentNumber(t, "coA", "INVOICE", y), lockInvoice: async (tx, id, co) => { await tx.$queryRaw`SELECT 1 FROM "invoices" WHERE "id" = ${id} AND "companyId" = ${co} FOR UPDATE` }, extraChecks: (t, inv) => depositIssueChecks(t, "coA", inv) })
    assert.ok(issued.ok, js(issued))
    let settled = false
    const t2 = updateDraftInvoice(db, A, fin, form(quote, lines("Modif tardive", "950"))).then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1), "la modification doit être bloquée par le verrou de l'émission")
    assert.equal(settled, false)
    await t1.commit()
    const r2 = await t2
    assert.equal(r2.ok, false); assert.match((r2 as { error: string }).error, /brouillon/)
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: fin }, include: { lines: true } })
    assert.equal(inv.status, "SENT"); assert.equal(inv.lines.find((l) => !l.deductsDepositId)?.designation, "Chantier", "aucune ligne remplacée après émission")
    // B. T1 (db2) remplace les lignes dans une transaction tenue ouverte ; T2 (db) émet : attend, puis émet la version finale.
    const quote2 = await acceptedQuote(db, A, "wA", lines("Chantier 2", "1000"))
    await issuedDeposit(db, A, quote2, { kind: "PERCENT", bp: 1000 })
    const fin2 = await finalDraft(db, A, quote2)
    const h = await holdTransaction(db2)
    const rep = await replaceInvoiceDraftCore(h.tx, { companyId: "coA", invoiceId: fin2, actorId: "admA", header: { dueDate: null, subject: null, notes: null, paymentTerms: null, globalDiscountBp: 0, vatReverseCharge: false, totalHT: "800.00", totalVAT: "160.00", totalTTC: "960.00", worksiteId: "wA", clientId: "clA", quoteId: quote2 }, lines: [{ articleId: null, designation: "Version finale", description: null, unit: "u", quantity: "1.00", unitPrice: "800.00", vatRate: "20", lineHT: "800.00", discountBp: 0, position: 0 }] })
    assert.ok(rep.ok, js(rep))
    const { applyDepositDeductionsCore } = await import("@/lib/billing/invoices/deposit.service")
    assert.ok((await applyDepositDeductionsCore(h.tx, A, fin2)).ok)
    let issuedSettled = false
    const t3 = issueInvoice(db, A, fin2, NOW).then((r) => { issuedSettled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1), "l'émission doit attendre la modification en cours")
    assert.equal(issuedSettled, false)
    await h.commit()
    const r3 = await t3
    assert.ok(r3.ok, js(r3))
    const inv2 = await db.invoice.findUniqueOrThrow({ where: { id: fin2 }, include: { lines: true } })
    assert.equal(inv2.status, "SENT"); assert.equal(inv2.lines.find((l) => !l.deductsDepositId)?.designation, "Version finale"); assert.equal(inv2.totalTTC.toFixed(2), "840.00") // 800 − 100 (acompte 10 % de 1000) = 700 HT ⇒ 840 TTC
  })
})
