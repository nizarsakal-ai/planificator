// T1 (revue Codex R3, 26/10/2026) — après l'avoir total d'une facture de solde émise, l'acompte redevient AFFECTABLE une seule fois
// à un nouveau solde du même devis (sans nouvel encaissement) ou CRÉDITABLE si aucun autre solde actif ne le déduit. La trace
// historique de déduction (solde annulé + avoir) est conservée et libérée (releasedAt), jamais supprimée ni réécrite.
// Reproduction Codex : devis 1 200, acompte 360 émis, solde 840 émis puis annulé par avoir total ⇒ reconversion OK (nouveau solde 840
// déduisant l'acompte), avoir sur l'acompte possible si aucun solde actif. Deux reconversions simultanées ; reconversion contre avoir
// acompte ; rollback sans brouillon résiduel ; paiements et rapprochement de l'acompte conservés sans duplication ; SQL direct refusé.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { convertQuote } from "@/lib/billing/quotes/quote.service"
import { issueInvoice, recordPayment } from "@/lib/billing/invoices/invoice.service"
import { createCreditNoteCore, transitionInvoiceCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { businessYear } from "@/lib/billing/business-day"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { importBankStatement, matchTransaction } from "@/lib/accounting/c5/bank.service"
import { A, NOW, holdTransaction, js, seedCompanies, useTestClock, waitFor, waitingSessions } from "./helpers"
import { acceptedQuote, finalDraft, issuedDeposit } from "./fixtures"

const db = new PrismaClient(), db2 = new PrismaClient()
const L = [{ designation: "Travaux", quantity: "1", unitPrice: "1000", vatRate: "20" }]
const credit = (id: string, client: PrismaClient = db) => client.$transaction(async (tx) => { const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId: id, actorId: "admA", reason: "annulation", now: NOW, nextNumber: (t, at) => nextDocumentNumber(t, "coA", "CREDIT_NOTE", businessYear(at)) }); if (r.ok) await flushDeferredConstraints(tx); return r })
const deductions = (dep: string) => db.invoiceDepositDeduction.findMany({ where: { depositInvoiceId: dep }, orderBy: { createdAt: "asc" }, select: { finalInvoiceId: true, releasedAt: true, amountTTCCents: true } })
const finals = (q: string) => db.invoice.findMany({ where: { quoteId: q, kind: "INVOICE" }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, totalTTC: true } })
async function cancelledFinalScenario() { const q = await acceptedQuote(db, A, "wA", L); const dep = await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 3000 }); const fin = await finalDraft(db, A, q); const e = await issueInvoice(db, A, fin, NOW); if (!e.ok) throw new Error(e.error); const c = await credit(fin); if (!c.ok) throw new Error(c.error); return { q, dep, fin } }

before(async () => { useTestClock(); process.env.BILLING_COMPLETE_ENABLED = "true"; setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); delete process.env.BILLING_COMPLETE_ENABLED; await db.$disconnect(); await db2.$disconnect() })

describe("T1 — réaffectation unique de l'acompte après annulation intégrale du solde", () => {
  it("reproduction Codex : solde → avoir total → reconversion OK ; la trace historique est libérée (conservée), la nouvelle affectation est active ; nouveau solde émis 840 € ; avoir sur l'acompte refusé tant que ce solde est émis ; PDF/snapshot du solde annulé conservés", async () => {
    const { q, dep, fin } = await cancelledFinalScenario()
    const before = await deductions(dep); assert.equal(before.length, 1); assert.ok(before[0].releasedAt, "libérée à l'annulation du solde"); assert.equal(before[0].finalInvoiceId, fin)
    const re = await convertQuote(db, A, q, NOW); assert.ok(re.ok, js(re)); if (!re.ok) return
    assert.equal(re.value.existing, false)
    const after = await deductions(dep)
    assert.deepEqual(after.map((d) => [d.finalInvoiceId === fin, d.releasedAt === null, Number(d.amountTTCCents)]), [[true, false, 36000], [false, true, 36000]], "trace historique intacte + une affectation active")
    const inv2 = await db.invoice.findUniqueOrThrow({ where: { id: re.value.invoiceId }, include: { lines: true } })
    assert.equal(inv2.totalTTC.toString(), "840"); assert.equal(inv2.lines.filter((l) => l.deductsDepositId === dep).length, 1)
    const iss = await issueInvoice(db, A, re.value.invoiceId, NOW); assert.ok(iss.ok, js(iss))
    assert.deepEqual((await finals(q)).map((f) => [f.status, f.totalTTC.toString()]), [["CANCELLED", "840"], ["SENT", "840"]])
    const refused = await credit(dep); assert.equal(refused.ok, false, "l'acompte est déduit sur le nouveau solde émis : avoir refusé"); assert.match((refused as { error: string }).error, /déduit sur une facture de solde émise/)
    // Trace : le solde annulé garde sa déduction (PDF « Acomptes déduits ») et son snapshot.
    assert.equal(await db.invoiceDocumentSnapshot.count({ where: { invoiceId: fin } }), 1)
    assert.equal(await db.invoiceDepositDeduction.count({ where: { finalInvoiceId: fin } }), 1)
  })
  it("solde annulé → avoir total sur l'acompte possible (aucun solde actif) ; le devis se reconvertit ensuite sans déduction (acompte annulé) : 1 200 €", async () => {
    const { q, dep } = await cancelledFinalScenario()
    const c = await credit(dep); assert.ok(c.ok, js(c))
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: dep } })).status, "CANCELLED")
    const re = await convertQuote(db, A, q, NOW); assert.ok(re.ok, js(re)); if (!re.ok) return
    const inv2 = await db.invoice.findUniqueOrThrow({ where: { id: re.value.invoiceId }, include: { depositDeductions: true } })
    assert.equal(inv2.totalTTC.toString(), "1200"); assert.equal(inv2.depositDeductions.length, 0)
    assert.equal((await deductions(dep)).length, 1, "trace historique conservée")
  })
  it("deux reconversions simultanées (deux connexions) ⇒ un seul brouillon, une seule affectation active ; SQL direct : seconde affectation active refusée (index partiel)", async () => {
    const { q, dep } = await cancelledFinalScenario()
    const [a, b] = await Promise.all([convertQuote(db, A, q, NOW), convertQuote(db2, A, q, NOW)])
    assert.ok(a.ok && b.ok, js([a, b]))
    assert.equal([a.value.existing, b.value.existing].filter((x) => x).length, 1, "une création, une reprise de l'existant"); assert.equal(a.value.invoiceId, b.value.invoiceId)
    assert.equal((await finals(q)).filter((f) => f.status !== "CANCELLED").length, 1)
    assert.equal((await deductions(dep)).filter((d) => d.releasedAt === null).length, 1)
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO invoice_deposit_deductions(id,"companyId","finalInvoiceId","depositInvoiceId","amountTTCCents") VALUES ('dup-${dep}','coA','${a.value.invoiceId}','${dep}',36000)`), /already exists|23505/)
    // Les traces libérées ne se modifient ni ne se suppriment ; une affectation ne se libère pas si le solde n'est pas annulé.
    const released = (await deductions(dep)).find((d) => d.releasedAt)!
    await assert.rejects(db.$executeRawUnsafe(`UPDATE invoice_deposit_deductions SET "amountTTCCents" = 1 WHERE "finalInvoiceId" = '${released.finalInvoiceId}'`), /DEPOSIT_DEDUCTION_IMMUTABLE/)
    await assert.rejects(db.$executeRawUnsafe(`DELETE FROM invoice_deposit_deductions WHERE "finalInvoiceId" = '${released.finalInvoiceId}'`), /DEPOSIT_DEDUCTION_IMMUTABLE/)
    await assert.rejects(db.$executeRawUnsafe(`UPDATE invoice_deposit_deductions SET "releasedAt" = now() WHERE "finalInvoiceId" = '${a.value.invoiceId}'`), /DEPOSIT_DEDUCTION_IMMUTABLE/)
  })
  it("reconversion contre avoir sur l'acompte (deux connexions, barrière) : avoir en cours (non committé) ⇒ la reconversion ATTEND l'acompte puis se pose sans déduction (1 200 €) ; reconversion d'abord ⇒ avoir refusé tant que le brouillon affecte l'acompte, accepté après abandon", async () => {
    // Ordre 1 (course réelle) : T_A tient l'acompte (FOR UPDATE, avoir non committé) ; T_B (reconversion) verrouille le devis puis la facture,
    // puis les acomptes du devis en partage ⇒ bloquée jusqu'au commit de T_A ; elle relit alors l'acompte ANNULÉ : aucune affectation.
    const s1 = await cancelledFinalScenario()
    const h = await holdTransaction(db2)
    const c = await createCreditNoteCore(h.tx, { companyId: "coA", invoiceId: s1.dep, actorId: "admA", reason: null, now: NOW, nextNumber: (t, at) => nextDocumentNumber(t, "coA", "CREDIT_NOTE", businessYear(at)) }); assert.ok(c.ok, js(c))
    let settled = false
    const pending = convertQuote(db, A, s1.q, NOW).finally(() => { settled = true })
    assert.ok(await waitFor(async () => (await waitingSessions(db2)) >= 1), "la reconversion doit attendre l'avoir en cours")
    assert.equal(settled, false, "pas de reconversion pendant l'avoir")
    await h.commit()
    const re = await pending; assert.ok(re.ok, js(re)); if (!re.ok) return
    const inv1 = await db.invoice.findUniqueOrThrow({ where: { id: re.value.invoiceId }, include: { depositDeductions: true } })
    assert.equal(inv1.depositDeductions.length, 0, "aucune affectation vers l'acompte annulé"); assert.equal(inv1.totalTTC.toString(), "1200")
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: s1.dep } })).status, "CANCELLED")
    // SQL direct : une affectation active vers un acompte annulé est refusée (garde à l'insertion, et contrainte différée au commit).
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO invoice_deposit_deductions(id,"companyId","finalInvoiceId","depositInvoiceId","amountTTCCents") VALUES ('race-${s1.dep}','coA','${re.value.invoiceId}','${s1.dep}',36000)`), /DEPOSIT_DEDUCTION_INVALID/)
    // Ordre 2 : reconversion d'abord (brouillon actif déduisant l'acompte), puis avoir sur l'acompte : REFUSÉ (une seule affectation active :
    // abandonner le brouillon d'abord) ; après abandon du brouillon (ses affectations sont supprimées), l'avoir est accepté.
    const s2 = await cancelledFinalScenario()
    const re2 = await convertQuote(db, A, s2.q, NOW); assert.ok(re2.ok); if (!re2.ok) return
    const c2 = await credit(s2.dep); assert.equal(c2.ok, false); assert.match((c2 as { error: string }).error, /brouillon de facture de solde/)
    const abandon = await db.$transaction(async (tx) => { const r = await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: re2.value.invoiceId, actorId: "admA", to: "CANCELLED", now: NOW }); if (r.ok) await flushDeferredConstraints(tx); return r }); assert.ok(abandon.ok, js(abandon))
    assert.equal((await deductions(s2.dep)).filter((d) => d.releasedAt === null).length, 0, "l'abandon du brouillon supprime son affectation (jamais émise : aucune trace à conserver)")
    const c3 = await credit(s2.dep); assert.ok(c3.ok, js(c3))
  })
  it("rollback : une reconversion dont la pose des déductions échoue ne laisse aucun brouillon résiduel ; paiements et rapprochement bancaire de l'acompte conservés sans duplication", async () => {
    const { q, dep } = await cancelledFinalScenario()
    // Paiement partiel + rapprochement bancaire de l'acompte AVANT la reconversion.
    const p = await recordPayment(db, A, dep, { amountCents: BigInt(10000), method: "TRANSFER", paidAt: NOW, reference: null, notes: null }, NOW); assert.ok(p.ok, js(p))
    const imp = await importBankStatement(db, A, `Date;Libellé;Montant;Référence\n10/03/2026;VIR ACOMPTE;260,00;R\n`, "acompte.csv", { date: 0, label: 1, amount: 2, reference: 3, headerRows: 1 }); assert.ok(imp.ok); if (!imp.ok) return
    const tx = await db.bankTransaction.findFirstOrThrow({ where: { importId: imp.value.importId } })
    const m = await matchTransaction(db, A, tx.id, { invoiceId: dep }); assert.ok(m.ok, js(m))
    const paymentsBefore = js(await db.invoicePayment.findMany({ where: { invoiceId: dep }, orderBy: { createdAt: "asc" }, select: { amountCents: true, bankTransactionId: true } }))
    // Échec forcé de la reconversion : la pose des déductions échoue APRÈS les écritures (brouillon créé, lignes posées) ⇒ ROLLBACK complet.
    const hooked = db.$extends({ query: { invoiceDepositDeduction: { async createMany({ args, query }) { await query(args); throw new Error("INJECTED_DEDUCTION_FAILURE") } } } }) as unknown as PrismaClient
    const countBefore = (await finals(q)).length
    const re = await convertQuote(hooked, A, q, NOW).then((r) => ({ r }), (e) => ({ error: String((e as Error).message).slice(0, 40) }))
    assert.ok("error" in re && /INJECTED_DEDUCTION_FAILURE/.test(re.error), js(re))
    assert.equal((await finals(q)).length, countBefore, "aucun brouillon résiduel après rollback")
    assert.equal(js(await db.invoicePayment.findMany({ where: { invoiceId: dep }, orderBy: { createdAt: "asc" }, select: { amountCents: true, bankTransactionId: true } })), paymentsBefore, "paiements et rapprochement intacts, non dupliqués")
    assert.equal((await db.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } })).status, "MATCHED")
  })
})
