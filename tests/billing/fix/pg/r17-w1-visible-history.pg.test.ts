// Deux connexions indépendantes ; barrière après les écritures métier, avant commit.
// Une date de création antérieure à la déclaration ne prouve pas l'inclusion dans son snapshot.
import assert from "node:assert/strict"
import { before, after, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { A, D, seedCompanies, useTestClock, withClock, AFTER_PERIODS, js } from "./helpers"
import { issuedInvoice } from "./fixtures"
import { recordPayment, reversePayment } from "@/lib/billing/invoices/invoice.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { computeVat } from "@/lib/accounting/c5/vat"
import { declareVat } from "@/lib/accounting/c5/vat-declaration"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
const db = new PrismaClient()
const lines = [{ designation: "A20", quantity: "1", unitPrice: "100", vatRate: "20" }, { designation: "B10", quantity: "1", unitPrice: "100", vatRate: "10" }]
const pay = (client: PrismaClient, inv: string, cents: number, date: string) => recordPayment(client, A, inv, { amountCents: BigInt(cents), method: "TRANSFER", paidAt: D(date), reference: null, notes: null }, new Date(`${date}T12:00:00Z`))
const decl = (year: number, month: string, end: string) => withClock(AFTER_PERIODS, () => declareVat(db, A, D(`${year}-${month}-01`), D(`${year}-${month}-${end}`), "ENCAISSEMENTS"))
const persisted = async () => ({ declarations: await db.vatDeclaration.count(), logs: await db.historyLog.count({ where: { entityType: "VatDeclaration" } }) })
before(async () => { useTestClock(); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

for (const [index, kind] of ["credit", "payment", "reversal", "rollback", "compensating", "included"].entries()) {
  it(`écriture ${kind} avant déclaration, commit après : comparaison de l'historique réellement visible`, async () => {
    const year = 2015 + index
    const inv = await issuedInvoice(db, A, "wA", lines, { now: new Date(`${year}-02-02T10:00:00Z`) })
    const firstPay = await pay(db, inv, 5000, `${year}-02-10`); assert.ok(firstPay.ok, js(firstPay)); if (!firstPay.ok) return
    const writer = new PrismaClient()
    let release!: () => void, ready!: () => void
    const gate = new Promise<void>(r => { release = r }), written = new Promise<void>(r => { ready = r })
    const original = writer.$transaction.bind(writer)
    ;(writer as any).$transaction = (fn: any, opts: any) => original(async tx => { const result = await fn(tx); ready(); await gate; if (kind === "rollback") throw new Error("ROLLBACK_TEST"); return result }, { ...opts, timeout: 15000 })
    const line = await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv, designation: "A20" } })
    const pending = kind === "payment" ? pay(writer, inv, 6000, `${year}-02-15`) : kind === "reversal" ? reversePayment(writer, A, firstPay.value.paymentId, "erreur", new Date(`${year}-02-20T10:00:00Z`)) : kind === "compensating" ? original(async tx => {
      // Deux écritures effectives compensées : le total seul ne prouve pas le même historique.
      // Les services métier séparés sont utilisés ci-dessous via un client transactionnel minimal.
      const facade = { $transaction: async (fn: any) => fn(tx) } as PrismaClient
      const added = await pay(facade, inv, 1000, `${year}-02-15`); assert.ok(added.ok, js(added)); if (!added.ok) throw new Error("payment")
      const reversed = await reversePayment(facade, A, added.value.paymentId, "erreur", new Date(`${year}-02-20T10:00:00Z`)); assert.ok(reversed.ok, js(reversed))
      ready(); await gate; return { ok: true }
    }, { timeout: 15000 }) : createPartialCreditNote(writer, A, inv, { kind: "LINES", items: [{ lineId: line.id, quantityHundredths: BigInt(100) }] }, "avoir concurrent", new Date(`${year}-02-05T10:00:00Z`))
    // Attacher immédiatement le gestionnaire évite un rejet non observé dans le scénario rollback.
    const completion = pending.then(value => ({ value }), error => ({ error }))
    try {
      await written
      if (kind === "included") { release(); const included = await completion; assert.ok("value" in included) }
      assert.equal(await db.invoice.count({ where: { creditedInvoiceId: inv } }), kind === "included" ? 1 : 0, "visibilité avant l'instantané déclaré")
      const feb = await decl(year, "02", "28"); assert.ok(feb.ok, js(feb)); if (!feb.ok) return
      const frozen = await db.vatDeclaration.findUniqueOrThrow({ where: { id: feb.value.id } }); assert.equal(frozen.collectedCents, BigInt(kind === "included" ? 455 : 652))
      assert.equal((frozen.details as any).allocationHistory.version, 1)
      release(); const done = await completion
      if (kind === "rollback") assert.ok("error" in done && /ROLLBACK_TEST/.test(String(done.error)))
      else { assert.ok("value" in done, js(done)); assert.ok((done as any).value.ok, js(done)) }
      const amount = (kind === "credit" || kind === "included") ? 6000 : kind === "payment" ? 12000 : kind === "reversal" ? 23000 : 18000
      assert.ok((await pay(db, inv, amount, `${year}-03-10`)).ok)
      const march = await computeVat(db, A, D(`${year}-03-01`), D(`${year}-03-31`), "ENCAISSEMENTS")
      const before = await persisted(); const result = await decl(year, "03", "31")
      if (kind === "rollback" || kind === "included") { assert.deepEqual(march.warnings, [], js(march.warnings)); assert.ok(result.ok, js(result)) }
      else { assert.ok(march.warnings.some(w => /effectivement inclus/.test(w)), js(march.warnings)); assert.equal(result.ok, false, js(result)); assert.deepEqual(await persisted(), before) }
      assert.equal((await db.vatDeclaration.findUniqueOrThrow({ where: { id: feb.value.id } })).collectedCents, frozen.collectedCents)
    } finally { release(); await completion; await writer.$disconnect() }
  })
}

it("déclaration sans empreinte : aucun historique rétroactif inventé, refus des événements dépendants", async () => {
  const inv = await issuedInvoice(db, A, "wA", lines, { now: new Date("2014-02-02T10:00:00Z") })
  assert.ok((await pay(db, inv, 5000, "2014-02-10")).ok)
  const first = await decl(2014, "02", "28"); assert.ok(first.ok, js(first)); if (!first.ok) return
  // Fixture d'une déclaration enregistrée par la version antérieure au correctif.
  await db.vatDeclaration.update({ where: { id: first.value.id }, data: { details: { outOfContractChecked: true } } })
  assert.ok((await pay(db, inv, 18000, "2014-03-10")).ok)
  const v = await computeVat(db, A, D("2014-03-01"), D("2014-03-31"), "ENCAISSEMENTS")
  assert.ok(v.warnings.some(w => /sans empreinte/.test(w)), js(v.warnings)); const before = await persisted()
  assert.equal((await decl(2014, "03", "31")).ok, false); assert.deepEqual(await persisted(), before)
})
