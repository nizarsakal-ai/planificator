// Lot C2 — tests PostgreSQL (base jetable migrée) : émission numérotée sans trou, paiements concurrents plafonnés,
// contre-passation, statuts, déclencheurs (append-only, dépassement, statut), isolation, relances idempotentes, non-régression Lot B.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice, recordPayment, reversePayment, runInvoiceReminders, sendInvoiceMail, sendManualReminder, updateDraftInvoice } from "@/lib/billing/invoices/invoice.service"
import { getInvoiceDetail, invoiceSummary, listInvoices } from "@/lib/billing/invoices/invoice-queries"
import { buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { acceptQuoteManually, convertQuote, createQuote, sendQuote } from "@/lib/billing/quotes/quote.service"
import { createCreditNoteCore, transitionInvoiceCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL requis (base PostgreSQL jetable migrée)")
const db = new PrismaClient()
const A = { companyId: "coA", userId: "admA" }
const B = { companyId: "coB", userId: "admB" }
const mailer = new RecordingMailer()
const now = new Date("2026-03-10T10:00:00Z")
const form = (over: Record<string, unknown> = {}) => ({ worksiteId: "wA", lines: [{ designation: "Prestation", quantity: "1", unitPrice: "100", vatRate: "20" }], ...over })
const parsed = (over: Record<string, unknown> = {}) => { const r = parseInvoiceForm(form(over)); if (!r.ok) throw new Error(r.error); return r.value }
const pay = (amount: string, over: Record<string, unknown> = {}) => ({ amountCents: BigInt(amount), method: "TRANSFER" as const, paidAt: new Date("2026-03-10T00:00:00Z"), reference: null, notes: null, ...over })
async function sqlError(sql: string): Promise<string> { try { await db.$executeRawUnsafe(sql); return "NO_ERROR" } catch (e) { return String((e as Error).message) } }
const ids: Record<string, string> = {}

before(async () => {
  setBillingMailerForTests(mailer)
  await db.$executeRawUnsafe(`INSERT INTO companies(id,name,slug,siret,address,"updatedAt") VALUES ('coA','Société A','a','12345678900012','1 rue A',now()),('coB','Société B','b',NULL,NULL,now())`)
  await db.$executeRawUnsafe(`INSERT INTO users(id,email,password,role,"companyId","updatedAt") VALUES ('admA','a@x','x','ADMIN','coA',now()),('admB','b@x','x','ADMIN','coB',now())`)
  await db.$executeRawUnsafe(`INSERT INTO clients(id,"companyId",name,email,address,"updatedAt") VALUES ('clA','coA','Client A','client-a@example.test','10 rue du Client',now()),('clB','coB','Client B','client-b@example.test','11 rue du Client',now())`)
  await db.$executeRawUnsafe(`INSERT INTO worksites(id,"companyId","clientId","createdById",name,"updatedAt") VALUES ('wA','coA','clA','admA','Maison A',now()),('wB','coB','clB','admB','Maison B',now())`)
})
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("Brouillons et émission", () => {
  it("brouillon à numéro provisoire ; modification ; société B ne voit rien", async () => {
    const r = await createDraftInvoice(db, A, parsed(), now)
    assert.ok(r.ok); if (!r.ok) return
    ids.d1 = r.value.id
    assert.match(r.value.number, /^PROV-2026-\d{4}$/)
    assert.equal((await updateDraftInvoice(db, A, ids.d1, parsed({ lines: [{ designation: "P", quantity: "2", unitPrice: "100", vatRate: "10" }] }))).ok, true)
    const d = await db.invoice.findUniqueOrThrow({ where: { id: ids.d1 } })
    assert.equal(d.totalTTC.toFixed(2), "220.00")
    assert.deepEqual(await updateDraftInvoice(db, B, ids.d1, parsed()), { ok: false, error: "Chantier introuvable." })
    assert.equal((await listInvoices(db, "coB", {})).total, 0)
    assert.equal(await getInvoiceDetail(db, "coB", ids.d1), null)
  })
  it("émission : numéros FAC-2026-0001, 0002 sans trou malgré un brouillon abandonné ; société B refusée ; chemin Lot B refuse PROV", async () => {
    const abandoned = await createDraftInvoice(db, A, parsed(), now); assert.ok(abandoned.ok); if (!abandoned.ok) return
    assert.deepEqual(await issueInvoice(db, B, ids.d1, now), { ok: false, error: "Facture introuvable." })
    const legacy = await db.$transaction((tx) => transitionInvoiceCore(tx, { companyId: "coA", invoiceId: ids.d1, to: "SENT", actorId: "admA", now }))
    assert.equal(legacy.ok, false)
    const r1 = await issueInvoice(db, A, ids.d1, now)
    assert.deepEqual(r1, { ok: true, value: { number: "FAC-2026-0001" } })
    await db.$transaction(async (tx) => { await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: abandoned.value.id, to: "CANCELLED", actorId: "admA", now }); await flushDeferredConstraints(tx) })
    const d2 = await createDraftInvoice(db, A, parsed({ dueDate: "2026-03-01" }), now); assert.ok(d2.ok); if (!d2.ok) return
    ids.d2 = d2.value.id
    const r2 = await issueInvoice(db, A, ids.d2, now)
    assert.deepEqual(r2, { ok: true, value: { number: "FAC-2026-0002" } })
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: ids.d2 } })
    assert.equal(inv.status, "SENT"); assert.equal(inv.issueDate.toISOString(), "2026-03-10T00:00:00.000Z"); assert.equal(inv.dueDate?.toISOString(), "2026-04-09T00:00:00.000Z", "échéance passée remplacée par émission + 30 j")
    assert.deepEqual(await issueInvoice(db, A, ids.d2, now), { ok: false, error: "Seule une facture brouillon peut être émise ou modifiée." })
  })
  it("deux émissions concurrentes du même brouillon ⇒ un seul numéro", async () => {
    const d = await createDraftInvoice(db, A, parsed(), now); assert.ok(d.ok); if (!d.ok) return
    const results = await Promise.all([issueInvoice(db, A, d.value.id, now), issueInvoice(db, A, d.value.id, now)])
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: d.value.id } })).number, "FAC-2026-0003")
    assert.equal((await db.documentCounter.findUniqueOrThrow({ where: { companyId_type_year: { companyId: "coA", type: "INVOICE", year: 2026 } } })).lastValue, 3)
  })
  it("émission bloquée si le vendeur n'a pas de SIRET/adresse (société B)", async () => {
    const d = await createDraftInvoice(db, B, { ...parsed(), worksiteId: "wB" }, now); assert.ok(d.ok); if (!d.ok) return
    const r = await issueInvoice(db, B, d.value.id, now)
    assert.equal(r.ok, false); assert.match((r as { error: string }).error, /SIRET/)
  })
  it("conversion de devis → émission → PDF avec mentions", async () => {
    const q = parseQuoteForm({ worksiteId: "wA", issueDate: "2026-03-10", lines: [{ designation: "Pose", quantity: "1", unitPrice: "50", vatRate: "20" }] })
    assert.ok(q.ok); if (!q.ok) return
    const cq = await createQuote(db, A, q.value); assert.ok(cq.ok); if (!cq.ok) return
    await sendQuote(db, A, cq.value.id, now); await acceptQuoteManually(db, A, cq.value.id, now)
    const conv = await convertQuote(db, A, cq.value.id, now); assert.ok(conv.ok); if (!conv.ok) return
    const r = await issueInvoice(db, A, conv.value.invoiceId, now)
    assert.deepEqual(r, { ok: true, value: { number: "FAC-2026-0004" } })
    const pdf = await buildInvoicePdfData(db, "coA", conv.value.invoiceId)
    assert.equal(pdf?.title, "FACTURE"); assert.ok(pdf?.mentions.some((m) => /40 €/.test(m))); assert.ok(pdf?.meta.some((m) => m.label === "Devis"))
    assert.equal(await buildInvoicePdfData(db, "coB", conv.value.invoiceId), null)
  })
})

describe("Paiements", () => {
  it("partiel ⇒ PARTIAL ; concurrence : deux paiements dépassant ensemble le reste ⇒ un seul accepté ; solde ⇒ PAID", async () => {
    const p1 = await recordPayment(db, A, ids.d2, pay("10000"), now)
    assert.ok(p1.ok); if (!p1.ok) return
    assert.equal(p1.value.status, "PARTIAL"); assert.equal(p1.value.remainingCents, BigInt(2000))
    const results = await Promise.all([recordPayment(db, A, ids.d2, pay("1500"), now), recordPayment(db, A, ids.d2, pay("1500"), now)])
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.match(results.find((r) => !r.ok)?.error ?? "", /dépasse/)
    const inv1 = await db.invoice.findUniqueOrThrow({ where: { id: ids.d2 } })
    assert.equal(inv1.status, "PARTIAL")
    const p3 = await recordPayment(db, A, ids.d2, pay("500"), now)
    assert.ok(p3.ok && p3.value.status === "PAID")
    const inv2 = await db.invoice.findUniqueOrThrow({ where: { id: ids.d2 } })
    assert.equal(inv2.status, "PAID"); assert.equal(inv2.paidAt?.toISOString(), now.toISOString())
    assert.deepEqual(await recordPayment(db, A, ids.d2, pay("1"), now), { ok: false, error: "Cette facture est déjà soldée." })
    assert.deepEqual(await recordPayment(db, B, ids.d2, pay("1"), now), { ok: false, error: "Facture introuvable." })
    ids.payFirst = p1.value.paymentId
  })
  it("contre-passation : PAID → PARTIAL, paidAt effacé ; SQL direct : DELETE/UPDATE refusés, paiement sur brouillon refusé, dépassement refusé au COMMIT", async () => {
    const r = await reversePayment(db, A, ids.payFirst, "erreur de saisie", now)
    assert.deepEqual(r, { ok: true, value: { status: "PARTIAL" } })
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: ids.d2 } })
    assert.equal(inv.status, "PARTIAL"); assert.equal(inv.paidAt, null)
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: ids.d2 } }), 4)
    assert.match(await sqlError(`DELETE FROM invoice_payments WHERE "invoiceId"='${ids.d2}'`), /PAYMENT_IMMUTABLE/)
    assert.match(await sqlError(`UPDATE invoice_payments SET "amountCents"=1 WHERE "invoiceId"='${ids.d2}'`), /PAYMENT_IMMUTABLE/)
    const draft = await createDraftInvoice(db, A, parsed(), now); assert.ok(draft.ok); if (!draft.ok) return
    assert.match(await sqlError(`INSERT INTO invoice_payments(id,"companyId","invoiceId","amountCents",method,"paidAt","recordedById") VALUES ('px','coA','${draft.value.id}',100,'CASH','2026-03-12','admA')`), /PAYMENT_INVALID/)
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO invoice_payments(id,"companyId","invoiceId","amountCents",method,"paidAt","recordedById") VALUES ('py','coA','${ids.d2}',99999,'CASH','2026-03-12','admA')`)
      await flushDeferredConstraints(tx)
    }), /PAYMENT_EXCEEDS_TOTAL/)
    // Statut incohérent posé par SQL direct (PAID sans somme = TTC) : refusé au COMMIT.
    await assert.rejects(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE invoices SET status='PAID', "paidAt"=now() WHERE id='${ids.d2}'`)
      await flushDeferredConstraints(tx)
    }), /PAYMENT_STATUS_MISMATCH/)
    // Autre société : la FK composite refuse un paiement de B sur une facture de A.
    assert.match(await sqlError(`INSERT INTO invoice_payments(id,"companyId","invoiceId","amountCents",method,"paidAt","recordedById") VALUES ('pz','coB','${ids.d2}',1,'CASH','2026-03-12','admB')`), /PAYMENT_INVALID|foreign key/)
  })
  it("indicateurs : total encaissé = Σ paiements (contre-passations incluses), total dû = Σ restes ; OVERDUE calculé", async () => {
    const s = await invoiceSummary(db, "coA", new Date("2026-05-01T00:00:00Z"))
    assert.equal(s.collectedCents, BigInt(2000)) // 100 + 15 + 5 − 100
    const detail = await getInvoiceDetail(db, "coA", ids.d2, new Date("2026-05-01T00:00:00Z"))
    assert.equal(detail?.remainingCents, BigInt(10000)); assert.equal(detail?.overdue, true); assert.equal(detail?.payable, true)
    assert.ok(s.dueCents >= BigInt(10000)); assert.ok(s.overdueCount >= 1)
    const list = await listInvoices(db, "coA", { overdue: true }, new Date("2026-05-01T00:00:00Z"))
    assert.ok(list.rows.some((r) => r.id === ids.d2 && r.overdue && r.status === "PARTIAL"))
    assert.equal((await listInvoices(db, "coA", { overdue: true }, now)).rows.some((r) => r.id === ids.d2), false)
  })
})

describe("Courriers et relances", () => {
  it("envoi et relance manuelle journalisés (SIMULATED) ; relances automatiques J+30/45/60 idempotentes", async () => {
    const before = mailer.sent.length
    assert.equal((await sendInvoiceMail(db, A, ids.d2)).ok, true)
    assert.equal((await sendManualReminder(db, A, ids.d2, now)).ok, true)
    assert.equal(mailer.sent.length, before + 2)
    assert.equal(await db.billingMailLog.count({ where: { documentId: ids.d2, status: "SIMULATED" } }), 2)
    const t45 = new Date("2026-05-25T10:00:00Z") // échéance 09/04 + 46 j
    const r1 = await runInvoiceReminders(db, t45)
    const due = r1.reminders
    assert.ok(due.find((x) => x.step === 30)!.sent >= 1 && due.find((x) => x.step === 45)!.sent >= 1 && due.find((x) => x.step === 60)!.sent === 0)
    const r2 = await runInvoiceReminders(db, t45)
    assert.deepEqual(r2.reminders.map((x) => x.sent), [0, 0, 0])
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: ids.d2 } })
    assert.ok(inv.reminderDue30SentAt && inv.reminderDue45SentAt && !inv.reminderDue60SentAt)
    assert.equal(await db.billingMailLog.count({ where: { documentId: ids.d2, kind: "INVOICE_REMINDER_30" } }), 1)
    assert.deepEqual(await sendManualReminder(db, B, ids.d2, now), { ok: false, error: "Seule une facture émise non soldée peut être relancée." })
  })
})

describe("Non-régression Lot B", () => {
  it("avoir total sur une facture PARTIELLEMENT PAYÉE : facture CANCELLED, avoir copie exacte (remises, autoliquidation), paiements conservés", async () => {
    const d = await createDraftInvoice(db, A, parsed({ globalDiscount: "10", vatReverseCharge: true, lines: [{ designation: "X", description: "détail", quantity: "1", unitPrice: "100", discount: "5", vatRate: "20" }] }), now)
    assert.ok(d.ok); if (!d.ok) return
    assert.ok((await issueInvoice(db, A, d.value.id, now)).ok)
    const p = await recordPayment(db, A, d.value.id, pay("1000"), now)
    assert.ok(p.ok && p.value.status === "PARTIAL")
    const note = await db.$transaction(async (tx) => {
      const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId: d.value.id, actorId: "admA", reason: null, now, nextNumber: (t) => nextDocumentNumber(t, "coA", "CREDIT_NOTE", 2026) })
      await flushDeferredConstraints(tx)
      return r
    })
    assert.ok(note.ok); if (!note.ok) return
    const n = await db.invoice.findUniqueOrThrow({ where: { id: note.value.id }, include: { lines: true } })
    assert.equal(n.globalDiscountBp, 1000); assert.equal(n.vatReverseCharge, true); assert.equal(n.lines[0].discountBp, 500); assert.equal(n.lines[0].description, "détail"); assert.equal(n.totalTTC.toFixed(2), "85.50")
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: d.value.id } })).status, "CANCELLED")
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: d.value.id } }), 1)
    assert.deepEqual(await reversePayment(db, A, p.value.paymentId, "x", now), { ok: false, error: "Facture annulée par avoir : le remboursement des paiements reçus se traite depuis l'avoir." })
  })
  it("facture PAID du Lot B (sans paiement enregistré) : reste à payer 0, PDF « acquittée », courrier reste 0", async () => {
    const d = await createDraftInvoice(db, A, parsed(), now); assert.ok(d.ok); if (!d.ok) return
    assert.ok((await issueInvoice(db, A, d.value.id, now)).ok)
    await db.$transaction(async (tx) => { await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: d.value.id, to: "PAID", actorId: "admA", now }); await flushDeferredConstraints(tx) })
    const det = await getInvoiceDetail(db, "coA", d.value.id)
    assert.equal(det?.remainingCents, BigInt(0)); assert.equal(det?.paidCents, BigInt(12000)); assert.equal(det?.settledOutside, true)
    assert.ok((await listInvoices(db, "coA", { status: "PAID" })).rows.every((r) => r.remainingCents === BigInt(0)))
    const pdf = await buildInvoicePdfData(db, "coA", d.value.id)
    // P2-03 : le suivi des règlements est une annexe distincte de la pièce émise (`settlement`), jamais figée.
    assert.ok(pdf?.settlement?.rows.some((r) => /acquittée/.test(r)))
    assert.ok(!pdf?.extraBlocks?.some((b) => b.rows.some((r) => /Reste à payer/.test(r))))
    assert.ok((await sendInvoiceMail(db, A, d.value.id)).ok)
    assert.ok(mailer.sent.at(-1)?.text.includes("Reste à payer : 0,00"))
  })
  it("règlement constaté manuellement (chemin Lot B, sans ligne de paiement) toujours accepté", async () => {
    const d = await createDraftInvoice(db, A, parsed(), now); assert.ok(d.ok); if (!d.ok) return
    assert.ok((await issueInvoice(db, A, d.value.id, now)).ok)
    const r = await db.$transaction(async (tx) => { const r = await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: d.value.id, to: "PAID", actorId: "admA", now }); await flushDeferredConstraints(tx); return r })
    assert.equal(r.ok, true)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: d.value.id } })).status, "PAID")
  })
})
