// P1-03 / P1-04 — Rapprochement bancaire atomique et idempotent (une transaction : opération → paiement/règlement → liens → MATCHED),
// pannes injectées après chaque mutation et entre les frontières, concurrence à deux sessions, reprise idempotente ; règlement
// fournisseur de montant EXACT sous verrou, tout échec après réservation ⇒ rollback des deux objets.
// Invariants : une opération ⇒ au plus un paiement (invoice_payments.bankTransactionId UNIQUE) ; MATCHED ⇔ liens cohérents (CHECK +
// contrôle différé) ; une facture fournisseur réglée une seule fois (index unique partiel), par un débit égal à son TTC.
import assert from "node:assert/strict"
import { after, afterEach, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { runAccountingTransaction } from "@/lib/accounting/engine/transaction"
import { BANK_ERRORS, autoReconcile, importBankStatement, matchTransaction, setBankReconcileHooksForTests } from "@/lib/accounting/c5/bank.service"
import { postMissingDocuments, postPaymentEntry } from "@/lib/accounting/c5/postings"
import { createSupplierInvoice, validateSupplierInvoice } from "@/lib/accounting/c5/supplier-invoice.service"
import { A, B, D, NOW, holdTransaction, js, seedCompanies, sqlError, waitFor, waitingSessions } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const db2 = new PrismaClient()
const M = { date: 0, label: 1, amount: 2, reference: 3, headerRows: 1 }
let n = 0
async function bankLine(ctx: typeof A, amount: string, label = "VIR", ref?: string): Promise<string> {
  const csv = `Date;Libellé;Montant;Référence\n12/03/2026;${label} ${++n};${amount};${ref ?? `R${n}`}\n`
  const r = await importBankStatement(db, ctx, csv, `r${n}.csv`, M); if (!r.ok) throw new Error(r.error)
  const t = await db.bankTransaction.findFirstOrThrow({ where: { importId: r.value.importId } })
  return t.id
}
async function supplier(ctx: typeof A, ttc: bigint, number: string): Promise<string> {
  const c = await createSupplierInvoice(db, ctx, { supplierName: "Fournisseur F", siret: null, number, date: D("2026-03-05"), dueDate: null, totalHTCents: ttc * BigInt(5) / BigInt(6), vatCents: ttc - ttc * BigInt(5) / BigInt(6), totalTTCCents: ttc, vatRateBp: 2000, category: "services", expenseAccountId: null, notes: null }, { fileId: null, ocr: null })
  if (!c.ok) throw new Error(c.error)
  const v = await validateSupplierInvoice(db, ctx, c.value.id); if (!v.ok) throw new Error(v.error)
  return c.value.id
}
const state = async (txId: string) => { const t = await db.bankTransaction.findUniqueOrThrow({ where: { id: txId } }); return { status: t.status, inv: t.matchedInvoiceId, pay: t.matchedPaymentId, sup: t.matchedSupplierInvoiceId } }
const paymentsOf = (invoiceId: string) => db.invoicePayment.findMany({ where: { invoiceId }, select: { amountCents: true, bankTransactionId: true } })

before(async () => {
  process.env.BILLING_COMPLETE_ENABLED = "true"
  setBillingMailerForTests(new RecordingMailer())
  await seedCompanies(db)
  for (const ctx of [A, B]) { await db.$transaction((tx) => ensureBaseReferential(tx, ctx)); await db.$transaction((tx) => openFiscalYear(tx, ctx, { startDate: D("2026-01-01"), endDate: D("2026-12-31") })) }
})
afterEach(() => setBankReconcileHooksForTests(null))
after(async () => { setBillingMailerForTests(null); delete process.env.BILLING_COMPLETE_ENABLED; await db.$disconnect(); await db2.$disconnect() })

describe("P1-03 — rapprochement client", () => {
  it("facture 200 €, ligne 50 € : panne injectée après le paiement, après le lien, après le COMMIT ⇒ après reprise UN SEUL paiement de 50 €, une seule liaison, au plus une écriture BQ", async () => {
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "166.67", vatRate: "20" }]) // 200,00 TTC
    const tx1 = await bankLine(A, "50,00")
    // Panne 1 : après création du paiement, avant le lien ⇒ rien de persisté.
    setBankReconcileHooksForTests({ afterPaymentCreated: async () => { throw new Error("PANNE_APRES_PAIEMENT") } })
    await assert.rejects(matchTransaction(db, A, tx1, { invoiceId: inv }), /PANNE_APRES_PAIEMENT/)
    assert.deepEqual(await paymentsOf(inv), []); assert.deepEqual(await state(tx1), { status: "PENDING", inv: null, pay: null, sup: null })
    // Panne 2 : après le passage à MATCHED, avant le COMMIT ⇒ rien de persisté.
    setBankReconcileHooksForTests({ afterMatched: async () => { throw new Error("PANNE_APRES_LIEN") } })
    await assert.rejects(matchTransaction(db, A, tx1, { invoiceId: inv }), /PANNE_APRES_LIEN/)
    assert.deepEqual(await paymentsOf(inv), []); assert.deepEqual(await state(tx1), { status: "PENDING", inv: null, pay: null, sup: null })
    // Panne 3 : après le COMMIT (frontière de transaction, avant la comptabilisation) ⇒ paiement et lien committés une fois.
    setBankReconcileHooksForTests({ afterCommit: async () => { throw new Error("PANNE_APRES_COMMIT") } })
    await assert.rejects(matchTransaction(db, A, tx1, { invoiceId: inv }), /PANNE_APRES_COMMIT/)
    setBankReconcileHooksForTests(null)
    const pays = await paymentsOf(inv)
    assert.deepEqual(pays, [{ amountCents: BigInt(5000), bankTransactionId: tx1 }])
    const st = await state(tx1); assert.equal(st.status, "MATCHED"); assert.equal(st.inv, inv); assert.ok(st.pay)
    // Reprise : rejeu de la même opération ⇒ refus explicite, aucun second paiement ; rapprochement automatique ⇒ aucun effet.
    assert.deepEqual(await matchTransaction(db, A, tx1, { invoiceId: inv }), { ok: false, error: BANK_ERRORS.notPending })
    const auto = await autoReconcile(db, A); assert.equal(auto.matched, 0)
    assert.equal((await paymentsOf(inv)).length, 1)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: inv } })).status, "PARTIAL")
    // Écriture BQ : la génération manuelle répare sans doubler ; idempotente.
    const r1 = await postMissingDocuments(db, A); assert.equal(r1.errors.length, 0, js(r1.errors))
    const r2 = await postMissingDocuments(db, A); assert.equal(r2.posted, 0)
    assert.equal(await db.accountingDocumentPosting.count({ where: { sourceType: "PAYMENT", sourceId: st.pay! } }), 1)
    const again = await runAccountingTransaction(db, (tx) => postPaymentEntry(tx, A, st.pay!)); assert.equal(again.existing, true)
  })
  it("deux sessions rapprochant la même ligne (barrière) ⇒ une seule conséquence financière ; double requête ⇒ un seul paiement", async () => {
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
    const txId = await bankLine(A, "40,00")
    // Session 1 (db2) tient le verrou de l'opération ; la session 2 (db) attend puis constate MATCHED.
    const h = await holdTransaction(db2)
    await h.tx.$queryRawUnsafe(`SELECT 1 FROM bank_transactions WHERE id = '${txId}' FOR UPDATE`)
    let settled = false
    const second = matchTransaction(db, A, txId, { invoiceId: inv }).then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1)); assert.equal(settled, false)
    // La session 1 effectue elle-même le rapprochement dans sa transaction (même chemin métier, via recordPaymentTx + liens), puis commit.
    const { recordPaymentTx } = await import("@/lib/billing/invoices/invoice.service")
    const p = await recordPaymentTx(h.tx, A, inv, { amountCents: BigInt(4000), method: "TRANSFER", paidAt: NOW, reference: "s1", notes: null, bankTransactionId: txId }, NOW); assert.ok(p.ok, js(p))
    await h.tx.bankTransaction.updateMany({ where: { id: txId, status: "PENDING" }, data: { status: "MATCHED", matchedInvoiceId: inv, matchedPaymentId: p.value.paymentId, matchedAt: NOW } })
    await h.commit()
    assert.deepEqual(await second, { ok: false, error: BANK_ERRORS.notPending })
    assert.equal((await paymentsOf(inv)).length, 1)
    // Double requête simultanée (même processus, deux connexions du pool) sur une autre ligne.
    const txB = await bankLine(A, "30,00")
    const both = await Promise.all([matchTransaction(db, A, txB, { invoiceId: inv }), matchTransaction(db2, A, txB, { invoiceId: inv })])
    assert.equal(both.filter((r) => r.ok).length, 1, js(both))
    assert.equal((await paymentsOf(inv)).length, 2)
  })
  it("paiement refusé (plafond dépassé, facture étrangère, débit sur facture client, drapeau OFF) ⇒ aucune réservation MATCHED orpheline ni paiement partiel", async () => {
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "10", vatRate: "20" }]) // 12,00
    const invB = await issuedInvoice(db, B, "wB", [{ designation: "PB", quantity: "1", unitPrice: "10", vatRate: "20" }])
    const big = await bankLine(A, "99,00"), debit = await bankLine(A, "-5,00"), ok = await bankLine(A, "12,00")
    const r1 = await matchTransaction(db, A, big, { invoiceId: inv }); assert.equal(r1.ok, false); assert.match((r1 as { error: string }).error, /reste à payer/)
    const r2 = await matchTransaction(db, A, ok, { invoiceId: invB }); assert.deepEqual(r2, { ok: false, error: "Facture introuvable." })
    const r3 = await matchTransaction(db, A, debit, { invoiceId: inv }); assert.deepEqual(r3, { ok: false, error: BANK_ERRORS.debitOnInvoice })
    delete process.env.BILLING_COMPLETE_ENABLED
    assert.deepEqual(await matchTransaction(db, A, ok, { invoiceId: inv }), { ok: false, error: BANK_ERRORS.flagOff })
    process.env.BILLING_COMPLETE_ENABLED = "true"
    for (const t of [big, debit, ok]) assert.deepEqual(await state(t), { status: "PENDING", inv: null, pay: null, sup: null })
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: { in: [inv, invB] } } }), 0)
    assert.equal(await db.bankTransaction.count({ where: { companyId: "coA", status: "MATCHED", matchedPaymentId: null, matchedInvoiceId: { not: null } } }), 0)
    assert.ok((await matchTransaction(db, A, ok, { invoiceId: inv })).ok)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: inv } })).status, "PAID")
  })
  it("preuve de rollback réelle : erreur Prisma levée dans la transaction (contrainte différée) ⇒ rien en base ; SQL direct : second paiement pour la même opération refusé (UNIQUE), MATCHED sans paiement refusé (CHECK)", async () => {
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
    const txId = await bankLine(A, "20,00")
    // Lien incohérent forcé juste avant le COMMIT : le contrôle différé bank_match_check refuse ⇒ la transaction entière est annulée.
    setBankReconcileHooksForTests({ afterMatched: async (tx, id) => { await tx.$executeRawUnsafe(`UPDATE bank_transactions SET "matchedInvoiceId" = NULL, "matchedPaymentId" = NULL, "matchedSupplierInvoiceId" = NULL, status = 'PENDING' WHERE id = '${id}'`) } })
    await assert.rejects(matchTransaction(db, A, txId, { invoiceId: inv }), /BANK_MATCH_INVALID/)
    setBankReconcileHooksForTests(null)
    assert.deepEqual(await paymentsOf(inv), []); assert.deepEqual(await state(txId), { status: "PENDING", inv: null, pay: null, sup: null })
    assert.ok((await matchTransaction(db, A, txId, { invoiceId: inv })).ok)
    assert.match(await sqlError(db, `INSERT INTO invoice_payments(id,"companyId","invoiceId","amountCents",method,"paidAt","recordedById","bankTransactionId") VALUES ('dup','coA','${inv}',2000,'TRANSFER','2026-03-12','admA','${txId}')`), /23505|already exists/)
    const other = await bankLine(A, "7,00")
    assert.match(await sqlError(db, `UPDATE bank_transactions SET status='MATCHED', "matchedInvoiceId"='${inv}' WHERE id='${other}'`), /bank_transactions_match_state_ck|check constraint/)
    assert.match(await sqlError(db, `UPDATE invoice_payments SET "bankTransactionId"=NULL WHERE "bankTransactionId"='${txId}'`), /PAYMENT_IMMUTABLE/)
  })
})

describe("P1-04 — rapprochement fournisseur (règlement intégral, montant exact)", () => {
  it("facture 300 € : −1 € refusée sans mutation ; −300 € acceptée ; −301 €, +300 €, facture étrangère/rejetée/déjà payée refusées ; rejeu sans effet", async () => {
    const s = await supplier(A, BigInt(30000), "F-300")
    const one = await bankLine(A, "-1,00"), exact = await bankLine(A, "-300,00"), more = await bankLine(A, "-301,00"), credit = await bankLine(A, "300,00")
    const r1 = await matchTransaction(db, A, one, { supplierInvoiceId: s }); assert.equal(r1.ok, false); assert.match((r1 as { error: string }).error, /exactement égal au TTC/)
    assert.deepEqual(await state(one), { status: "PENDING", inv: null, pay: null, sup: null }); assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: s } })).paidAt, null)
    const r2 = await matchTransaction(db, A, more, { supplierInvoiceId: s }); assert.equal(r2.ok, false); assert.match((r2 as { error: string }).error, /exactement/)
    assert.deepEqual(await matchTransaction(db, A, credit, { supplierInvoiceId: s }), { ok: false, error: BANK_ERRORS.creditOnSupplier })
    const sB = await supplier(B, BigInt(30000), "FB-300")
    assert.deepEqual(await matchTransaction(db, A, exact, { supplierInvoiceId: sB }), { ok: false, error: BANK_ERRORS.supplierNotFound })
    const pending = await createSupplierInvoice(db, A, { supplierName: "Fournisseur F", siret: null, number: "F-PEND", date: D("2026-03-05"), dueDate: null, totalHTCents: BigInt(25000), vatCents: BigInt(5000), totalTTCCents: BigInt(30000), vatRateBp: 2000, category: null, expenseAccountId: null, notes: null }, { fileId: null, ocr: null }); assert.ok(pending.ok); if (!pending.ok) return
    assert.deepEqual(await matchTransaction(db, A, exact, { supplierInvoiceId: pending.value.id }), { ok: false, error: BANK_ERRORS.supplierNotValidated })
    const ok = await matchTransaction(db, A, exact, { supplierInvoiceId: s }); assert.ok(ok.ok, js(ok))
    assert.ok((await db.supplierInvoice.findUniqueOrThrow({ where: { id: s } })).paidAt); assert.equal((await state(exact)).sup, s)
    const again = await bankLine(A, "-300,00")
    assert.deepEqual(await matchTransaction(db, A, again, { supplierInvoiceId: s }), { ok: false, error: BANK_ERRORS.supplierPaid })
    assert.deepEqual(await matchTransaction(db, A, exact, { supplierInvoiceId: s }), { ok: false, error: BANK_ERRORS.notPending })
    assert.equal(await db.bankTransaction.count({ where: { matchedSupplierInvoiceId: s } }), 1)
  })
  it("deux lignes concurrentes de −300 € pour une même facture ⇒ un seul succès, la perdante reste PENDING, la cible payée une fois ; panne après réservation et après règlement ⇒ rollback des deux objets", async () => {
    const s = await supplier(A, BigInt(30000), "F-CONC")
    const l1 = await bankLine(A, "-300,00"), l2 = await bankLine(A, "-300,00")
    const h = await holdTransaction(db2)
    await h.tx.$queryRawUnsafe(`SELECT 1 FROM supplier_invoices WHERE id = '${s}' FOR UPDATE`)
    let settled = false
    const waiting = matchTransaction(db, A, l2, { supplierInvoiceId: s }).then((r) => { settled = true; return r })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1)); assert.equal(settled, false)
    // Session 1 règle la facture avec l1 (mêmes écritures que le service), puis commit : la session 2 relit sous verrou ⇒ déjà réglée.
    await h.tx.bankTransaction.updateMany({ where: { id: l1, status: "PENDING" }, data: { status: "MATCHED", matchedSupplierInvoiceId: s, matchedAt: NOW } })
    await h.tx.supplierInvoice.updateMany({ where: { id: s, paidAt: null }, data: { paidAt: NOW } })
    await h.commit()
    assert.deepEqual(await waiting, { ok: false, error: BANK_ERRORS.supplierPaid })
    assert.equal((await state(l2)).status, "PENDING"); assert.equal(await db.bankTransaction.count({ where: { matchedSupplierInvoiceId: s, status: "MATCHED" } }), 1)
    // Pannes injectées.
    const s2 = await supplier(A, BigInt(30000), "F-PANNE")
    const l3 = await bankLine(A, "-300,00")
    setBankReconcileHooksForTests({ afterSupplierSettled: async () => { throw new Error("PANNE_APRES_REGLEMENT") } })
    await assert.rejects(matchTransaction(db, A, l3, { supplierInvoiceId: s2 }), /PANNE_APRES_REGLEMENT/)
    assert.deepEqual(await state(l3), { status: "PENDING", inv: null, pay: null, sup: null }); assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: s2 } })).paidAt, null)
    setBankReconcileHooksForTests({ afterMatched: async () => { throw new Error("PANNE_APRES_LIEN") } })
    await assert.rejects(matchTransaction(db, A, l3, { supplierInvoiceId: s2 }), /PANNE_APRES_LIEN/)
    assert.deepEqual(await state(l3), { status: "PENDING", inv: null, pay: null, sup: null }); assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: s2 } })).paidAt, null)
    setBankReconcileHooksForTests(null)
    assert.ok((await matchTransaction(db, A, l3, { supplierInvoiceId: s2 })).ok)
    // SQL direct : second règlement MATCHED de la même facture refusé (index unique partiel) ; montant ≠ TTC refusé au COMMIT.
    const l4 = await bankLine(A, "-300,00")
    assert.match(await sqlError(db, `UPDATE bank_transactions SET status='MATCHED', "matchedSupplierInvoiceId"='${s2}' WHERE id='${l4}'`), /23505|already exists/)
    const s3 = await supplier(A, BigInt(30000), "F-SQL")
    const l5 = await bankLine(A, "-299,00")
    await assert.rejects(db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`UPDATE bank_transactions SET status='MATCHED', "matchedSupplierInvoiceId"='${s3}' WHERE id='${l5}'`); await tx.$executeRawUnsafe(`UPDATE supplier_invoices SET "paidAt"='2026-03-12' WHERE id='${s3}'`); await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL IMMEDIATE`) }), /SUPPLIER_PAYMENT_INVALID/)
    assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: s3 } })).paidAt, null)
  })
})
