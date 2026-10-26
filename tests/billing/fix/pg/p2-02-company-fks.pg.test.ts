// P2-02 — FK composites (companyId, id) : tout lien inter-sociétés est refusé par la base (INSERT et UPDATE), lien interne valide
// accepté ; liens optionnels nuls ; les services refusent les identifiants de B sans fuite ni mutation préalable.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { importBankStatement, matchTransaction } from "@/lib/accounting/c5/bank.service"
import { createSupplierInvoice, storeSupplierFile, validateSupplierInvoice } from "@/lib/accounting/c5/supplier-invoice.service"
import { recordPayment } from "@/lib/billing/invoices/invoice.service"
import { A, B, D, NOW, appClient, js, seedCompanies, sqlError, useTestClock } from "./helpers"
import { acceptedQuote, issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const app = appClient()
const FK = /23503|foreign key|violates/
const ids: Record<string, string> = {}

before(async () => {
  useTestClock() // R3 : horloge de décision déterministe (= NOW)
  process.env.BILLING_COMPLETE_ENABLED = "true"; setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db)
  for (const ctx of [A, B]) { await db.$transaction((tx) => ensureBaseReferential(tx, ctx)); await db.$transaction((tx) => openFiscalYear(tx, ctx, { startDate: D("2026-01-01"), endDate: D("2026-12-31") })) }
  // Objets de A et de B.
  for (const [k, ctx, w] of [["A", A, "wA"], ["B", B, "wB"]] as const) {
    ids[`inv${k}`] = await issuedInvoice(db, ctx, w, [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
    const p = await recordPayment(db, ctx, ids[`inv${k}`], { amountCents: BigInt(1000), method: "CASH", paidAt: NOW, reference: null, notes: null }, NOW); if (!p.ok) throw new Error(p.error); ids[`pay${k}`] = p.value.paymentId
    const imp = await importBankStatement(db, ctx, `Date;Libellé;Montant;Référence\n12/03/2026;VIR ${k};50,00;R${k}\n12/03/2026;PRLV ${k};-120,00;S${k}\n`, `${k}.csv`, { date: 0, label: 1, amount: 2, reference: 3, headerRows: 1 }); if (!imp.ok) throw new Error(imp.error); ids[`imp${k}`] = imp.value.importId
    ids[`tx${k}`] = (await db.bankTransaction.findFirstOrThrow({ where: { importId: ids[`imp${k}`], amountCents: BigInt(5000) } })).id
    ids[`txd${k}`] = (await db.bankTransaction.findFirstOrThrow({ where: { importId: ids[`imp${k}`], amountCents: BigInt(-12000) } })).id
    const f = await storeSupplierFile(db, ctx, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`png-${k}`)]), `f${k}.png`); if (!f.ok) throw new Error(f.error); ids[`file${k}`] = f.value.fileId
    const s = await createSupplierInvoice(db, ctx, { supplierName: `Fournisseur ${k}`, siret: null, number: `F-${k}`, date: D("2026-03-05"), dueDate: null, totalHTCents: BigInt(10000), vatCents: BigInt(2000), totalTTCCents: BigInt(12000), vatRateBp: 2000, category: "services", expenseAccountId: null, notes: null }, { fileId: ids[`file${k}`], ocr: null }); if (!s.ok) throw new Error(s.error); ids[`sup${k}`] = s.value.id
    const v = await validateSupplierInvoice(db, ctx, ids[`sup${k}`]); if (!v.ok) throw new Error(v.error); ids[`supplier${k}`] = v.value.supplierId
    ids[`quote${k}`] = await acceptedQuote(db, ctx, w, [{ designation: "Q", quantity: "1", unitPrice: "10", vatRate: "20" }])
  }
})
after(async () => { setBillingMailerForTests(null); delete process.env.BILLING_COMPLETE_ENABLED; await db.$disconnect(); await app.$disconnect() })

describe("P2-02 — SQL direct (rôle applicatif) : INSERT et UPDATE de chaque lien vers B depuis une ligne de A ⇒ violation FK ; lien interne ⇒ succès", () => {
  it("supplier_invoices → suppliers / files", async () => {
    const ins = (supplier: string, file: string, id: string) => `INSERT INTO supplier_invoices(id,"companyId","supplierName",number,date,"totalHTCents","vatCents","totalTTCCents","createdById","updatedAt","supplierId","fileId") VALUES ('${id}','coA','X','N-${id}','2026-03-01',1,0,1,'admA',now(),${supplier ? `'${supplier}'` : "NULL"},${file ? `'${file}'` : "NULL"})`
    assert.match(await sqlError(app, ins(ids.supplierB, "", "si1")), FK)
    assert.match(await sqlError(app, ins("", ids.fileB, "si2")), FK)
    assert.equal(await sqlError(app, ins(ids.supplierA, ids.fileA, "si3")), "NO_ERROR")
    assert.equal(await sqlError(app, ins("", "", "si4")), "NO_ERROR", "liens optionnels nuls")
    assert.match(await sqlError(app, `UPDATE supplier_invoices SET "supplierId"='${ids.supplierB}' WHERE id='si3'`), FK)
    assert.match(await sqlError(app, `UPDATE supplier_invoices SET "fileId"='${ids.fileB}' WHERE id='si3'`), FK)
  })
  it("bank_transactions → import / paiement / facture fournisseur ; invoice_payments → opération bancaire", async () => {
    const ins = (imp: string, id: string) => `INSERT INTO bank_transactions(id,"companyId","importId",date,label,"amountCents",fingerprint) VALUES ('${id}','coA','${imp}','2026-03-01','L',100,'fp-${id}')`
    assert.match(await sqlError(app, ins(ids.impB, "bt1")), FK)
    assert.equal(await sqlError(app, ins(ids.impA, "bt2")), "NO_ERROR")
    assert.match(await sqlError(app, `UPDATE bank_transactions SET status='MATCHED', "matchedInvoiceId"='${ids.invA}', "matchedPaymentId"='${ids.payB}' WHERE id='bt2'`), FK)
    assert.match(await sqlError(app, `UPDATE bank_transactions SET status='MATCHED', "matchedSupplierInvoiceId"='${ids.supB}' WHERE id='${ids.txdA}'`), FK)
    assert.match(await sqlError(app, `UPDATE bank_transactions SET "importId"='${ids.impB}' WHERE id='bt2'`), FK)
    assert.match(await sqlError(app, `INSERT INTO invoice_payments(id,"companyId","invoiceId","amountCents",method,"paidAt","recordedById","bankTransactionId") VALUES ('ip1','coA','${ids.invA}',100,'CASH','2026-03-01','admA','${ids.txB}')`), FK)
    assert.match(await sqlError(app, `INSERT INTO invoice_payments(id,"companyId","invoiceId","amountCents",method,"paidAt","recordedById") VALUES ('ip2','coA','${ids.invB}',100,'CASH','2026-03-01','admA')`), /FK|23503|foreign key|PAYMENT_INVALID/)
  })
  it("invoices → quotes (C1) et invoice_lines.deductsDepositId (C3) : même société imposée", async () => {
    const ins = (quote: string, id: string) => `INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"quoteId") VALUES ('${id}','coA','wA','clA','PROV-${id}','admA',now(),'DRAFT','INVOICE','${quote}')`
    assert.match(await sqlError(app, ins(ids.quoteB, "iq1")), FK)
    assert.equal(await sqlError(app, ins(ids.quoteA, "iq2")), "NO_ERROR")
    assert.match(await sqlError(app, `UPDATE invoices SET "quoteId"='${ids.quoteB}' WHERE id='iq2'`), FK)
    assert.match(await sqlError(app, `INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT","deductsDepositId") VALUES ('il1','iq2','D',1,-1,20,-1,'${ids.invB}')`), /DEPOSIT_DEDUCTION_INVALID/)
    assert.equal(await sqlError(app, `INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT","deductsDepositId") VALUES ('il2','iq2','D',1,-1,20,-1,'${ids.invA}')`), "NO_ERROR")
  })
})

describe("P2-02 — services avec des identifiants de B ⇒ refus sans fuite ni mutation", () => {
  it("rapprochement, facture fournisseur, fichier", async () => {
    const before = js(await db.bankTransaction.findMany({ where: { companyId: "coA" }, orderBy: { id: "asc" } }))
    assert.deepEqual(await matchTransaction(db, A, ids.txA, { invoiceId: ids.invB }), { ok: false, error: "Facture introuvable." })
    assert.deepEqual(await matchTransaction(db, A, ids.txB, { invoiceId: ids.invA }), { ok: false, error: "Opération bancaire introuvable." })
    assert.deepEqual(await matchTransaction(db, A, ids.txdA, { supplierInvoiceId: ids.supB }), { ok: false, error: "Facture fournisseur introuvable." })
    assert.equal(js(await db.bankTransaction.findMany({ where: { companyId: "coA" }, orderBy: { id: "asc" } })), before)
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: ids.invB, amountCents: BigInt(5000) } }), 0)
    const c = await createSupplierInvoice(db, A, { supplierName: "X", siret: null, number: "N", date: D("2026-03-01"), dueDate: null, totalHTCents: BigInt(1), vatCents: BigInt(0), totalTTCCents: BigInt(1), vatRateBp: null, category: null, expenseAccountId: null, notes: null }, { fileId: ids.fileB, ocr: null })
    assert.deepEqual(c, { ok: false, error: "Fichier introuvable." })
    assert.equal((await validateSupplierInvoice(db, A, ids.supB)).ok, false)
  })
})
