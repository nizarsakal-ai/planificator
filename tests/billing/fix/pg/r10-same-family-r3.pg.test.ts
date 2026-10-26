// Cycle R3 — défauts de MÊME FAMILLE que S1/S2/S3 relevés par l'audit interne et corrigés :
// #9 le contrôle différé du plafond des acomptes ne verrouille plus le devis sur un simple changement de statut (paiement, avoir,
// abandon) — plus d'arête acompte → devis au COMMIT ; #10 withLockRetry détecte les vrais interblocages (P2010/40P01) ;
// #3 un acompte annulé par avoir ne peut plus être déduit (contrainte différée) ; #12 contre-passation datée du jour Paris de la
// décision ; #2 chemin Lot B : refus d'émettre une facture liée à un devis porteur d'acomptes ; #5 chemin Lot B : refus de remplacer
// les lignes d'un solde avec déductions ; #14 date d'émission Lot B = jour Paris de la décision ; #8 fichier fournisseur d'une facture
// rejetée réutilisable ; #15/#16 « aujourd'hui » du tableau de bord et des échéances = jour Paris.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice, recordPayment, reversePayment, withLockRetry } from "@/lib/billing/invoices/invoice.service"
import { LIFECYCLE_ERRORS, createCreditNoteCore, replaceDraftLinesCore, transitionInvoiceCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { todayUtc } from "@/lib/billing/invoices/invoice-queries"
import { accountingDashboard } from "@/lib/accounting/c5/dashboard"
import { createSupplierInvoice, rejectSupplierInvoice, storeSupplierFile } from "@/lib/accounting/c5/supplier-invoice.service"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { A, D, NOW, holdTransaction, js, seedCompanies, useTestClock, waitFor, waitingOnTable, waitingSessions } from "./helpers"
import { acceptedQuote, finalDraft, issuedDeposit } from "./fixtures"

const db = new PrismaClient(), db2 = new PrismaClient()
const L = [{ designation: "Travaux", quantity: "1", unitPrice: "1000", vatRate: "20" }]
const totalNote = (invoiceId: string, now = NOW) => db.$transaction(async (tx) => { const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId, actorId: "admA", reason: null, now, nextNumber: (t) => nextDocumentNumber(t, "coA", "CREDIT_NOTE", 2026) }); if (r.ok) await flushDeferredConstraints(tx); return r })

before(async () => { useTestClock(); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db); await db.$transaction((tx) => ensureBaseReferential(tx, A)); await db.$transaction((tx) => openFiscalYear(tx, A, { startDate: D("2026-01-01"), endDate: D("2026-12-31") })) })
after(async () => { setBillingMailerForTests(null); setBillingClockForTests(() => NOW); await db.$disconnect(); await db2.$disconnect() })

describe("#9 — plafond des acomptes : plus de verrou du devis sur un changement de statut", () => {
  it("devis verrouillé (verrou métier FOR NO KEY UPDATE) par une autre session : le paiement d'un acompte émis et son avoir total aboutissent sans attendre ; une modification de montant (SQL) attend toujours le devis", async () => {
    const q = await acceptedQuote(db, A, "wA", L)
    const dep = await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 3000 })
    const dep2 = await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 2000 })
    const h = await holdTransaction(db2); await h.tx.$queryRawUnsafe(`SELECT 1 FROM quotes WHERE id = '${q}' FOR NO KEY UPDATE`)
    const t0 = Date.now()
    const pay = await recordPayment(db, A, dep, { amountCents: BigInt(36000), method: "TRANSFER", paidAt: D("2026-03-09"), reference: null, notes: null }, NOW); assert.ok(pay.ok, js(pay))
    const cn = await totalNote(dep2); assert.ok(cn.ok, js(cn))
    assert.ok(Date.now() - t0 < 2000, "aucune attente du verrou du devis (contrôle différé non déclenché par un changement de statut)")
    // Changement de montant d'un acompte brouillon (SQL direct) : le plafond est contrôlé et attend le devis.
    const q2 = await acceptedQuote(db, A, "wA", L)
    const d3 = await (await import("@/lib/billing/invoices/deposit.service")).createDepositInvoice(db, A, q2, { kind: "PERCENT", bp: 1000 }, NOW); assert.ok(d3.ok); if (!d3.ok) return
    await h.tx.$queryRawUnsafe(`SELECT 1 FROM quotes WHERE id = '${q2}' FOR NO KEY UPDATE`)
    let settled = false
    const upd = db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`UPDATE invoices SET "totalTTC" = 500 WHERE id = '${d3.value.id}'`); await flushDeferredConstraints(tx) }).then(() => { settled = true })
    assert.ok(await waitFor(async () => (await waitingSessions(db)) >= 1), "la modification de montant attend le devis (plafond)"); assert.equal(settled, false)
    await h.commit(); await upd
  })
})

describe("#10 — withLockRetry sur un vrai interblocage PostgreSQL (P2010 / 40P01)", () => {
  it("deux transactions prenant deux lignes dans l'ordre inverse : la transaction enveloppée attend la première (victime désignée), est rejouée et aboutit ; l'autre aboutit", async () => {
    const q1 = await acceptedQuote(db, A, "wA", L), q2 = await acceptedQuote(db, A, "wA", L)
    let attempts = 0
    const h = await holdTransaction(db2); await h.tx.$queryRawUnsafe(`SELECT 1 FROM quotes WHERE id = '${q2}' FOR UPDATE`)
    const victim = withLockRetry(() => db.$transaction(async (tx) => {
      attempts++
      await tx.$queryRawUnsafe(`SELECT 1 FROM quotes WHERE id = '${q1}' FOR UPDATE`)
      await tx.$queryRawUnsafe(`SELECT 1 FROM quotes WHERE id = '${q2}' FOR UPDATE`) // attend h (premier à attendre ⇒ détecte le cycle ⇒ victime)
      return "ok"
    }, { timeout: 15000 }))
    assert.ok(await waitFor(async () => (await waitingOnTable(db, "quotes")) >= 1), "la transaction enveloppée attend q2")
    const other = await h.tx.$queryRawUnsafe(`SELECT 1 FROM quotes WHERE id = '${q1}' FOR UPDATE`).then(() => "ok", (e) => `err:${String((e as { meta?: { code?: string } }).meta?.code ?? (e as Error).message).slice(0, 5)}`) // ferme le cycle
    assert.equal(other, "ok", "h n'est pas la victime")
    await h.commit()
    assert.equal(await victim, "ok"); assert.equal(attempts, 2, "une victime 40P01 (P2010) puis un rejeu réussi")
  })
})

describe("#3 / #2 / #5 / #14 — déductions et chemin Lot B", () => {
  it("#3 : acompte affecté à un brouillon de solde ⇒ avoir refusé (T1 : une affectation active) ; après abandon du brouillon ⇒ avoir OK ; une liaison vers un acompte annulé est refusée dès l'INSERT (SQL direct) et à l'émission (contrainte différée)", async () => {
    const q = await acceptedQuote(db, A, "wA", L)
    const dep = await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 3000 })
    const fin = await finalDraft(db, A, q)
    const cn = await totalNote(dep); assert.equal(cn.ok, false); assert.match((cn as { error: string }).error, /brouillon de facture de solde/)
    const abandon = await db.$transaction(async (tx) => { const r = await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: fin, actorId: "admA", to: "CANCELLED", now: NOW }); if (r.ok) await flushDeferredConstraints(tx); return r }); assert.ok(abandon.ok, js(abandon))
    const cn2 = await totalNote(dep); assert.ok(cn2.ok, js(cn2))
    // Nouveau solde : l'acompte annulé n'est plus déduit (1 200 €) ; une liaison SQL vers cet acompte annulé est refusée à l'insertion.
    const fin2 = await finalDraft(db, A, q)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: fin2 } })).totalTTC.toString(), "1200")
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO invoice_deposit_deductions(id,"companyId","finalInvoiceId","depositInvoiceId","amountTTCCents") VALUES ('bad-${dep}','coA','${fin2}','${dep}',36000)`), /DEPOSIT_DEDUCTION_INVALID: seul un acompte émis/)
  })
  it("#2 : chemin Lot B — une facture FAC liée à un devis porteur d'acomptes ne s'émet pas par transitionInvoiceCore ; sans acompte, elle s'émet avec la date d'émission du jour Paris de la décision (#14)", async () => {
    const q = await acceptedQuote(db, A, "wA", L)
    await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 3000 })
    await db.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId","quoteId",number,status,kind,"createdById","updatedAt","totalHT","totalVAT","totalTTC") VALUES ('lotb-q','coA','wA','clA','${q}','FAC-2026-7791','DRAFT','INVOICE','admA',now(),1000,200,1200)`)
    await db.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('lotb-q-l','lotb-q','Travaux',1,1000,20,1000)`)
    const r = await db.$transaction((tx) => transitionInvoiceCore(tx, { companyId: "coA", invoiceId: "lotb-q", actorId: "admA", to: "SENT", now: NOW }))
    assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.quoteHasDeposits })
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: "lotb-q" } })).status, "DRAFT")
    const q2 = await acceptedQuote(db, A, "wA", L) // sans acompte
    await db.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId","quoteId",number,status,kind,"createdById","updatedAt","totalHT","totalVAT","totalTTC","issueDate") VALUES ('lotb-q2','coA','wA','clA','${q2}','FAC-2026-7792','DRAFT','INVOICE','admA',now(),1000,200,1200,'2026-01-05T15:00:00Z')`)
    await db.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('lotb-q2-l','lotb-q2','Travaux',1,1000,20,1000)`)
    const late = new Date("2026-12-31T23:30:00Z")
    // Année Paris de l'émission (2027) ≠ série du numéro (FAC-2026) : sans fournisseur de numéro ⇒ refus ; avec (action réelle) ⇒ renumérotée FAC-2027.
    assert.deepEqual(await db.$transaction((tx) => transitionInvoiceCore(tx, { companyId: "coA", invoiceId: "lotb-q2", actorId: "admA", to: "SENT", now: late })), { ok: false, error: LIFECYCLE_ERRORS.yearMismatch })
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: "lotb-q2" } })).status, "DRAFT")
    const r2 = await db.$transaction(async (tx) => { const t = await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: "lotb-q2", actorId: "admA", to: "SENT", now: late, nextNumber: (t2, y) => nextDocumentNumber(t2, "coA", "INVOICE", y) }); if (t.ok) await flushDeferredConstraints(tx); return t })
    assert.deepEqual(r2, { ok: true, value: undefined })
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: "lotb-q2" } })
    assert.match(inv.number, /^FAC-2027-\d{4}$/, "renumérotée dans la série de l'année d'émission"); assert.equal(inv.issueDate.toISOString(), "2027-01-01T00:00:00.000Z", "date d'émission = jour Paris de la décision"); assert.equal(inv.sentAt?.toISOString(), late.toISOString())
    assert.equal(await db.historyLog.count({ where: { entityId: "lotb-q2", detail: { contains: "renumérotée depuis FAC-2026-7792" } } }), 1)
    // Même année : numéro conservé.
    await db.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,status,kind,"createdById","updatedAt","totalHT","totalVAT","totalTTC") VALUES ('lotb-q3','coA','wA','clA','FAC-2026-7793','DRAFT','INVOICE','admA',now(),10,2,12)`)
    await db.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('lotb-q3-l','lotb-q3','T',1,10,20,10)`)
    const r3 = await db.$transaction(async (tx) => { const t = await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: "lotb-q3", actorId: "admA", to: "SENT", now: NOW, nextNumber: (t2, y) => nextDocumentNumber(t2, "coA", "INVOICE", y) }); if (t.ok) await flushDeferredConstraints(tx); return t }); assert.ok(r3.ok)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: "lotb-q3" } })).number, "FAC-2026-7793")
  })
  it("#5 : chemin Lot B — replaceDraftLinesCore refuse un brouillon de solde avec déductions (aucune écriture)", async () => {
    const q = await acceptedQuote(db, A, "wA", L)
    await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 3000 })
    const fin = await finalDraft(db, A, q)
    const before = js(await db.invoice.findUniqueOrThrow({ where: { id: fin }, include: { lines: true, depositDeductions: true } }))
    const r = await db.$transaction((tx) => replaceDraftLinesCore(tx, { companyId: "coA", invoiceId: fin, actorId: "admA", lines: [{ articleId: null, designation: "X", unit: "u", quantity: 1, unitPrice: 1, vatRate: 20, lineHT: 1, position: 0 }], totals: { totalHT: 1, totalVAT: 0.2, totalTTC: 1.2 } }))
    assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.hasDeductions })
    assert.equal(js(await db.invoice.findUniqueOrThrow({ where: { id: fin }, include: { lines: true, depositDeductions: true } })), before)
  })
})

describe("#12 / #15 / #16 / #8 — dates Paris et fichier fournisseur", () => {
  it("#12 : contre-passation à 2026-12-31T23:30Z ⇒ paidAt 2027-01-01 (jour Paris) ; #15/#16 : « aujourd'hui » = jour Paris", async () => {
    const f = parseInvoiceForm({ worksiteId: "wA", lines: L }); assert.ok(f.ok); if (!f.ok) return
    const d = await createDraftInvoice(db, A, f.value, NOW); assert.ok(d.ok); if (!d.ok) return
    assert.ok((await issueInvoice(db, A, d.value.id, NOW)).ok)
    const p = await recordPayment(db, A, d.value.id, { amountCents: BigInt(120000), method: "TRANSFER", paidAt: D("2026-12-30"), reference: null, notes: null }, new Date("2026-12-30T12:00:00Z")); assert.ok(p.ok, js(p)); if (!p.ok) return
    const late = new Date("2026-12-31T23:30:00Z"); setBillingClockForTests(() => late)
    const rev = await reversePayment(db, A, p.value.paymentId, "erreur", late); assert.ok(rev.ok, js(rev))
    const reversal = await db.invoicePayment.findFirstOrThrow({ where: { reversesPaymentId: p.value.paymentId } })
    assert.equal(reversal.paidAt.toISOString(), "2027-01-01T00:00:00.000Z")
    assert.equal(todayUtc(late).toISOString(), "2027-01-01T00:00:00.000Z")
    const dash = await accountingDashboard(db, A, late, "DEBITS")
    assert.equal(dash.vat.periodStart.toISOString(), "2027-01-01T00:00:00.000Z", "période TVA du tableau de bord = mois de Paris (janvier 2027)")
    setBillingClockForTests(() => NOW)
  })
  it("#8 : le fichier d'une facture fournisseur REJETÉE est réutilisable (plus refusé comme doublon) ; rattaché à une facture en cours : refusé", async () => {
    const data = Buffer.from("%PDF-1.4 test fournisseur r10")
    const f1 = await storeSupplierFile(db, A, data, "f.pdf"); assert.ok(f1.ok, js(f1)); if (!f1.ok) return
    const inv = await createSupplierInvoice(db, A, { supplierName: "Fournisseur R10", siret: null, number: "R10-1", date: D("2026-03-05"), dueDate: null, totalHTCents: BigInt(10000), vatCents: BigInt(2000), totalTTCCents: BigInt(12000), vatRateBp: 2000, category: "services", expenseAccountId: null, notes: null }, { fileId: f1.value.fileId, ocr: null }); assert.ok(inv.ok); if (!inv.ok) return
    const dup = await storeSupplierFile(db, A, data, "f.pdf"); assert.equal(dup.ok, false)
    assert.ok((await rejectSupplierInvoice(db, A, inv.value.id, "doublon")).ok)
    const again = await storeSupplierFile(db, A, data, "f.pdf"); assert.ok(again.ok, js(again)); if (!again.ok) return
    assert.equal(again.value.fileId, f1.value.fileId); assert.equal(again.value.duplicate, true)
  })
})
