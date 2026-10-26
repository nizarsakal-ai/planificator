// V1 : un avoir antidaté avant l'encaissement mais enregistré après la déclaration ne doit
// pas laisser déclarer les périodes suivantes sur une base cumulative incohérente.
import assert from "node:assert/strict"
import { before, after, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { A, D, seedCompanies, useTestClock, withClock, AFTER_PERIODS, js } from "./helpers"
import { issuedInvoice } from "./fixtures"
import { recordPayment } from "@/lib/billing/invoices/invoice.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { computeVat } from "@/lib/accounting/c5/vat"
import { declareVat } from "@/lib/accounting/c5/vat-declaration"
const db = new PrismaClient()
before(async () => { useTestClock(); await seedCompanies(db) })
after(async () => { await db.$disconnect() })
for (const year of [2022, 2023]) {
  it(`avoir tardif antidaté avant paiement : ${year}, période suivante refusée et déclaration antérieure inchangée`, async () => {
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "A20", quantity: "1", unitPrice: "100", vatRate: "20" }, { designation: "B10", quantity: "1", unitPrice: "100", vatRate: "10" }], { now: new Date(`${year}-02-02T10:00:00Z`) })
    const p = await recordPayment(db, A, inv, { amountCents: BigInt(5000), method: "TRANSFER", paidAt: D(`${year}-02-10`), reference: null, notes: null }, new Date(`${year}-02-10T12:00:00Z`)); assert.ok(p.ok, js(p))
    const first = await withClock(AFTER_PERIODS, () => declareVat(db, A, D(`${year}-02-01`), D(`${year}-02-28`), "ENCAISSEMENTS")); assert.ok(first.ok, js(first)); if (!first.ok) return
    const stored = await db.vatDeclaration.findUniqueOrThrow({ where: { id: first.value.id } }); assert.equal(stored.collectedCents, BigInt(652))
    const line = await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv, designation: "A20" } })
    const c = await createPartialCreditNote(db, A, inv, { kind: "LINES", items: [{ lineId: line.id, quantityHundredths: BigInt(100) }] }, "correction tardive", new Date(`${year}-02-05T10:00:00Z`)); assert.ok(c.ok, js(c))
    const q = await recordPayment(db, A, inv, { amountCents: BigInt(6000), method: "TRANSFER", paidAt: D(`${year}-03-10`), reference: null, notes: null }, new Date(`${year}-03-10T12:00:00Z`)); assert.ok(q.ok, js(q))
    const mar = await computeVat(db, A, D(`${year}-03-01`), D(`${year}-03-31`), "ENCAISSEMENTS")
    assert.equal(mar.collectedCents, BigInt(545)); assert.ok(mar.warnings.some(w => /avoir AV-.*absent de la déclaration figée/.test(w)), js(mar.warnings))
    const before = { declarations: await db.vatDeclaration.count(), logs: await db.historyLog.count({ where: { entityType: "VatDeclaration" } }) }
    const result = await withClock(AFTER_PERIODS, () => declareVat(db, A, D(`${year}-03-01`), D(`${year}-03-31`), "ENCAISSEMENTS")); assert.equal(result.ok, false, js(result))
    assert.deepEqual({ declarations: await db.vatDeclaration.count(), logs: await db.historyLog.count({ where: { entityType: "VatDeclaration" } }) }, before)
    assert.equal((await db.vatDeclaration.findUniqueOrThrow({ where: { id: first.value.id } })).collectedCents, stored.collectedCents)
  })
}
