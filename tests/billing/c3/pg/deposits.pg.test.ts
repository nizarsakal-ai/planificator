// Lot C3 — tests PostgreSQL : acomptes depuis un devis accepté (plafond, concurrence), émission, déductions sur la facture
// de solde, contrôles d'émission du solde, isolation, déclencheurs.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { acceptQuoteManually, convertQuote, createQuote, sendQuote } from "@/lib/billing/quotes/quote.service"
import { issueInvoice, recordPayment } from "@/lib/billing/invoices/invoice.service"
import { applyDepositDeductions, createDepositInvoice, listQuoteDeposits } from "@/lib/billing/invoices/deposit.service"
import { getInvoiceDetail } from "@/lib/billing/invoices/invoice-queries"
import { buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { createCreditNoteCore, transitionInvoiceCore } from "@/lib/billing/invoice-lifecycle.core"
import { runInvoiceReminders } from "@/lib/billing/invoices/invoice.service"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "coA", userId: "admA" }
const B = { companyId: "coB", userId: "admB" }
const now = new Date("2026-03-10T10:00:00Z")
const ids: Record<string, string> = {}
async function sqlError(sql: string): Promise<string> { try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) } }

before(async () => {
  setBillingClockForTests(() => now) // R3 : horloge de décision déterministe dans les tests
  setBillingMailerForTests(new RecordingMailer())
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('coA','Société A','a','12345678900012','1 rue A',now()),('coB','Société B','b','98765432100011','2 rue B',now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('admA','a@x','x','ADMIN','coA',now()),('admB','b@x','x','ADMIN','coB',now())`)
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,email,address,"updatedAt") VALUES ('clA','coA','Client A','client-a@example.test','10 rue du Client',now()),('clB','coB','Client B','client-b@example.test','11 rue du Client',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','admA','Maison A',now()),('wB','coB','clB','admB','Maison B',now())`)
  // Devis multi-taux : 1 000 HT à 20 % + 333,33 HT à 10 % ⇒ TTC 1 566,66
  const q = parseQuoteForm({ worksiteId: "wA", issueDate: "2026-03-10", lines: [{ designation: "Gros œuvre", quantity: "1", unitPrice: "1000", vatRate: "20" }, { designation: "Finitions", quantity: "1", unitPrice: "333,33", vatRate: "10" }] })
  if (!q.ok) throw new Error(q.error)
  const cq = await createQuote(db, A, q.value); if (!cq.ok) throw new Error(cq.error)
  ids.quote = cq.value.id
})
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("Création d'acomptes", () => {
  it("refusé sur un devis non accepté ; société B ⇒ introuvable", async () => {
    assert.deepEqual(await createDepositInvoice(db, A, ids.quote, { kind: "PERCENT", bp: 3000 }, now), { ok: false, error: "Un acompte ne se crée que sur un devis accepté ou converti." })
    await sendQuote(db, A, ids.quote, now); await acceptQuoteManually(db, A, ids.quote, now)
    assert.deepEqual(await createDepositInvoice(db, B, ids.quote, { kind: "PERCENT", bp: 3000 }, now), { ok: false, error: "Devis introuvable." })
  })
  it("30 % puis 50 % : lignes par taux exactes ; 3e acompte de 30 % refusé (plafond) ; concurrence : un seul des deux acomptes de 20 % passe", async () => {
    const d1 = await createDepositInvoice(db, A, ids.quote, { kind: "PERCENT", bp: 3000 }, now)
    assert.ok(d1.ok); if (!d1.ok) return
    ids.dep1 = d1.value.id
    assert.equal(d1.value.ttcCents, BigInt(47000))
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: ids.dep1 }, include: { lines: { orderBy: { position: "asc" } } } })
    assert.equal(inv.kind, "DEPOSIT"); assert.equal(inv.status, "DRAFT"); assert.equal(inv.depositBp, 3000); assert.match(inv.number, /^PROV-/)
    assert.deepEqual(inv.lines.map((l) => [l.vatRate.toFixed(2), l.lineHT.toFixed(2)]), [["10.00", "100.00"], ["20.00", "300.00"]])
    const d2 = await createDepositInvoice(db, A, ids.quote, { kind: "AMOUNT_TTC", cents: BigInt(78333) }, now)
    assert.ok(d2.ok); if (!d2.ok) return
    ids.dep2 = d2.value.id
    assert.equal(d2.value.ttcCents, BigInt(78333))
    assert.deepEqual(await createDepositInvoice(db, A, ids.quote, { kind: "PERCENT", bp: 3000 }, now), { ok: false, error: "Le total des acomptes dépasserait le montant TTC du devis." })
    // 20 % en pourcentage donnerait 313,34 (arrondis par ligne) > reste 313,33 ⇒ refusé par le plafond : on teste la concurrence sur le reste exact en montant TTC.
    assert.deepEqual(await createDepositInvoice(db, A, ids.quote, { kind: "PERCENT", bp: 2000 }, now), { ok: false, error: "Le total des acomptes dépasserait le montant TTC du devis." })
    const results = await Promise.all([createDepositInvoice(db, A, ids.quote, { kind: "AMOUNT_TTC", cents: BigInt(31333) }, now), createDepositInvoice(db, A, ids.quote, { kind: "AMOUNT_TTC", cents: BigInt(31333) }, now)])
    assert.equal(results.filter((r) => r.ok).length, 1)
    const ok = results.find((r) => r.ok); if (ok && ok.ok) ids.dep3 = ok.value.id
    assert.equal((await listQuoteDeposits(db, "coA", ids.quote)).length, 3)
  })
  it("émission des acomptes (numéros légaux), paiement d'un acompte, SQL direct au-delà du plafond refusé au COMMIT", async () => {
    assert.deepEqual(await issueInvoice(db, A, ids.dep1, now), { ok: true, value: { number: "FAC-2026-0001" } })
    assert.deepEqual(await issueInvoice(db, A, ids.dep2, now), { ok: true, value: { number: "FAC-2026-0002" } })
    const p = await recordPayment(db, A, ids.dep1, { amountCents: BigInt(47000), method: "TRANSFER", paidAt: now, reference: null, notes: null }, now)
    assert.ok(p.ok && p.value.status === "PAID")
    const pdf = await buildInvoicePdfData(db, "coA", ids.dep1)
    assert.equal(pdf?.title, "FACTURE D'ACOMPTE"); assert.ok(pdf?.meta.some((m) => m.label === "Devis"))
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE invoices SET "totalTTC" = 99999 WHERE id = '${ids.dep3}'`)
      await flushDeferredConstraints(tx)
    }), /DEPOSIT_EXCEEDS_QUOTE/)
  })
})

describe("Facture de solde", () => {
  it("conversion : lignes du devis + déductions des acomptes émis ; émission refusée tant qu'un acompte est en brouillon", async () => {
    const conv = await convertQuote(db, A, ids.quote, now)
    assert.ok(conv.ok); if (!conv.ok) return
    ids.final = conv.value.invoiceId
    const f = await getInvoiceDetail(db, "coA", ids.final)
    assert.ok(f); if (!f) return
    assert.equal(f.lines.filter((l) => l.designation.startsWith("Déduction acompte")).length, 4) // 2 acomptes × 2 taux
    assert.equal(f.totalTTCCents, BigInt(156666 - 47000 - 78333))
    assert.equal(await db.invoiceDepositDeduction.count({ where: { finalInvoiceId: ids.final } }), 2)
    const r = await issueInvoice(db, A, ids.final, now)
    assert.equal(r.ok, false); assert.match((r as { error: string }).error, /brouillon/)
  })
  it("3e acompte émis puis déductions recalculées ; émission du solde ; contenu figé ; avoir total sur un acompte déduit refusé", async () => {
    assert.ok((await issueInvoice(db, A, ids.dep3, now)).ok)
    const r0 = await issueInvoice(db, A, ids.final, now)
    assert.equal(r0.ok, false); assert.match((r0 as { error: string }).error, /recalculez/)
    const d = await applyDepositDeductions(db, A, ids.final)
    assert.deepEqual(d, { ok: true, value: { deposits: 3, ttcCents: BigInt(156666 - 47000 - 78333 - 31333) } })
    assert.deepEqual(await applyDepositDeductions(db, B, ids.final), { ok: false, error: "Facture introuvable." })
    const r = await issueInvoice(db, A, ids.final, now)
    assert.ok(r.ok); if (!r.ok) return
    const f = await db.invoice.findUniqueOrThrow({ where: { id: ids.final } })
    assert.equal(f.status, "PAID", "solde nul soldé à l'émission"); assert.equal(f.totalTTC.toFixed(2), "0.00")
    assert.match(await sqlError(`DELETE FROM invoice_deposit_deductions WHERE "finalInvoiceId"='${ids.final}'`), /DEPOSIT_DEDUCTION_IMMUTABLE/)
    assert.deepEqual(await applyDepositDeductions(db, A, ids.final), { ok: false, error: "Les déductions ne se recalculent que sur une facture de solde en brouillon." })
    const pdf = await buildInvoicePdfData(db, "coA", ids.final)
    assert.ok(pdf?.extraBlocks?.some((b) => b.title === "Acomptes déduits" && b.rows.length === 3))
    const note = await db.$transaction(async (tx) => createCreditNoteCore(tx, { companyId: "coA", invoiceId: ids.dep2, actorId: "admA", reason: null, now, nextNumber: (t) => nextDocumentNumber(t, "coA", "CREDIT_NOTE", 2026) }))
    assert.equal(note.ok, false); assert.match((note as { error: string }).error, /déduit sur une facture de solde émise/)
    assert.deepEqual(await createDepositInvoice(db, A, ids.quote, { kind: "PERCENT", bp: 100 }, now), { ok: false, error: "La facture de solde est déjà émise : plus d'acompte possible." })
  })
  it("solde émis à 0 € ⇒ PAID immédiatement, aucune relance ; détail non payable", async () => {
    const f = await db.invoice.findUniqueOrThrow({ where: { id: ids.final } })
    assert.equal(f.totalTTC.toFixed(2), "0.00"); assert.equal(f.status, "PAID"); assert.ok(f.paidAt)
    const det = await getInvoiceDetail(db, "coA", ids.final)
    assert.equal(det?.payable, false)
    const r = await runInvoiceReminders(db, new Date("2026-07-01T00:00:00Z"))
    assert.equal(await db.billingMailLog.count({ where: { documentId: ids.final } }), 0, JSON.stringify(r))
  })
})

describe("Abandon, avoir et reprise", () => {
  it("acompte brouillon : abandon (DRAFT → CANCELLED) possible ; avoir total sur un acompte émis non déduit possible", async () => {
    const q = parseQuoteForm({ worksiteId: "wA", issueDate: "2026-03-10", lines: [{ designation: "Travaux", quantity: "1", unitPrice: "1000", vatRate: "20" }] }); assert.ok(q.ok); if (!q.ok) return
    const cq = await createQuote(db, A, q.value); assert.ok(cq.ok); if (!cq.ok) return
    await sendQuote(db, A, cq.value.id, now); await acceptQuoteManually(db, A, cq.value.id, now)
    const bad = await createDepositInvoice(db, A, cq.value.id, { kind: "PERCENT", bp: 9000 }, now); assert.ok(bad.ok); if (!bad.ok) return
    const cancel = await db.$transaction(async (tx) => { const r = await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: bad.value.id, to: "CANCELLED", actorId: "admA", now }); await flushDeferredConstraints(tx); return r })
    assert.deepEqual(cancel, { ok: true, value: undefined })
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: bad.value.id } })).status, "CANCELLED")
    const good = await createDepositInvoice(db, A, cq.value.id, { kind: "PERCENT", bp: 3000 }, now); assert.ok(good.ok); if (!good.ok) return
    assert.ok((await issueInvoice(db, A, good.value.id, now)).ok)
    const note = await db.$transaction(async (tx) => { const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId: good.value.id, actorId: "admA", reason: "erreur", now, nextNumber: (t) => nextDocumentNumber(t, "coA", "CREDIT_NOTE", 2026) }); await flushDeferredConstraints(tx); return r })
    assert.ok(note.ok, JSON.stringify(note))
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: good.value.id } })).status, "CANCELLED")
    assert.equal((await db.invoice.findFirstOrThrow({ where: { creditedInvoiceId: good.value.id } })).creditScope, "TOTAL")
    ids.quote2 = cq.value.id
  })
  it("brouillon de solde abandonné : déductions libérées, nouvelle facture de solde possible sur le devis converti", async () => {
    const dep = await createDepositInvoice(db, A, ids.quote2, { kind: "PERCENT", bp: 2000 }, now); assert.ok(dep.ok); if (!dep.ok) return
    assert.ok((await issueInvoice(db, A, dep.value.id, now)).ok)
    const conv = await convertQuote(db, A, ids.quote2, now); assert.ok(conv.ok); if (!conv.ok) return
    assert.equal(await db.invoiceDepositDeduction.count({ where: { finalInvoiceId: conv.value.invoiceId } }), 1)
    const cancel = await db.$transaction(async (tx) => { const r = await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: conv.value.invoiceId, to: "CANCELLED", actorId: "admA", now }); await flushDeferredConstraints(tx); return r })
    assert.ok(cancel.ok)
    assert.equal(await db.invoiceDepositDeduction.count({ where: { finalInvoiceId: conv.value.invoiceId } }), 0)
    const again = await convertQuote(db, A, ids.quote2, now); assert.ok(again.ok); if (!again.ok) return
    assert.equal(again.value.existing, false); assert.notEqual(again.value.invoiceId, conv.value.invoiceId)
    assert.equal(await db.invoiceDepositDeduction.count({ where: { finalInvoiceId: again.value.invoiceId } }), 1)
    assert.deepEqual(await issueInvoice(db, A, again.value.invoiceId, now), { ok: true, value: { number: (await db.invoice.findUniqueOrThrow({ where: { id: again.value.invoiceId } })).number } })
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: again.value.invoiceId } })).totalTTC.toFixed(2), "960.00")
  })
})
