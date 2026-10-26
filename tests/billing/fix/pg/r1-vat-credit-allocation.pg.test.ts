// R1 (revue Codex R2, 26/10/2026) — TVA sur les encaissements : l'assiette d'allocation est la facture NETTE de ses avoirs partiels
// (par taux). Reproduction Codex : A 100 € HT @20 % + B 100 € HT @10 % (230 TTC) ; avoir ciblé annulant A (120 TTC) ; encaissement
// des 110 € restants ⇒ TVA encaissée = 10,00 € (taux 10 %), 0 au taux 20 % — plus jamais 14,35. Variantes : inverse, plusieurs
// avoirs, paiement partiel avant/après l'avoir (réaffectation datée de l'avoir), périodes distinctes (déclaration figée),
// mono-taux inchangé, avoir total après encaissement (hors contrat ⇒ avertissement). Oracles chiffrés indépendants du code.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { recordPayment } from "@/lib/billing/invoices/invoice.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { createCreditNoteCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { computeVat } from "@/lib/accounting/c5/vat"
import { declareVat } from "@/lib/accounting/c5/vat-declaration"
import { A, AFTER_PERIODS, D, js, seedCompanies, useTestClock, withClock } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const MAR = [D("2026-03-01"), D("2026-03-31")] as const, APR = [D("2026-04-01"), D("2026-04-30")] as const, MAY = [D("2026-05-01"), D("2026-05-31")] as const
const enc = (p: readonly [Date, Date]) => computeVat(db, A, p[0], p[1], "ENCAISSEMENTS")
const byRate = (v: { collected: { vatRateBp: number; vatCents: bigint }[] }) => Object.fromEntries(v.collected.map((r) => [r.vatRateBp, Number(r.vatCents)]))
const baseByRate = (v: { collected: { vatRateBp: number; baseCents: bigint }[] }) => Object.fromEntries(v.collected.map((r) => [r.vatRateBp, Number(r.baseCents)]))
const pay = (inv: string, cents: number, day: string) => recordPayment(db, A, inv, { amountCents: BigInt(cents), method: "TRANSFER", paidAt: D(day), reference: null, notes: null }, new Date(`${day}T12:00:00Z`)).then((r) => { if (!r.ok) throw new Error(r.error); return r.value })
/** Facture A 100 HT @20 % + B 100 HT @10 % = 230 TTC, émise le `issued`. */
const multi = (issued: string) => issuedInvoice(db, A, "wA", [{ designation: "A20", quantity: "1", unitPrice: "100", vatRate: "20" }, { designation: "B10", quantity: "1", unitPrice: "100", vatRate: "10" }], { now: new Date(`${issued}T10:00:00Z`) })
const lineOf = async (inv: string, designation: string) => (await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv, designation } })).id
const creditLine = async (inv: string, designation: string, day: string, qtyHundredths = 100) => { const r = await createPartialCreditNote(db, A, inv, { kind: "LINES", items: [{ lineId: await lineOf(inv, designation), quantityHundredths: BigInt(qtyHundredths) }] }, `annulation ${designation}`, new Date(`${day}T10:00:00Z`)); if (!r.ok) throw new Error(r.error); return r.value }
// Les factures sont isolées par période de test (mars / avril / mai) pour des oracles absolus.

before(async () => { setBillingMailerForTests(new RecordingMailer()); useTestClock(); await seedCompanies(db) }) // horloge = NOW (les pièces sont datées à l'instant de décision) ; les déclarations utilisent withClock(AFTER_PERIODS)
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("R1 — allocation nette des avoirs ciblés (reproduction Codex et variantes)", () => {
  it("reproduction Codex : avoir annulant A (20 %) puis encaissement des 110 € ⇒ TVA 10,00 € au taux 10 %, 0 au taux 20 %, base 100 € ; aucun avertissement ; facture soldée", async () => {
    const inv = await multi("2026-03-02")
    await creditLine(inv, "A20", "2026-03-03")
    const p = await pay(inv, 11000, "2026-03-12")
    assert.equal(p.status, "PAID")
    const v = await enc(MAR)
    assert.equal(v.collectedCents, BigInt(1000), js(v))
    assert.deepEqual(byRate(v), { 1000: 1000 }); assert.deepEqual(baseByRate(v), { 1000: 10000 })
    assert.deepEqual(v.warnings, []); assert.equal(v.payments, 1); assert.equal(v.adjustments, 0)
    // Débits : facture 30 − avoir 20 = 10 (inchangé).
    const d = await computeVat(db, A, MAR[0], MAR[1], "DEBITS"); assert.equal(d.collectedCents, BigInt(1000)); assert.deepEqual(byRate(d), { 1000: 1000, 2000: 0 })
  })
  it("inverse : avoir annulant B (10 %) puis encaissement de 120 € ⇒ 20,00 € au taux 20 % seulement", async () => {
    const inv = await multi("2026-04-02")
    await creditLine(inv, "B10", "2026-04-03")
    await pay(inv, 12000, "2026-04-12")
    const v = await enc(APR)
    assert.deepEqual(byRate(v), { 2000: 2000 }, js(v)); assert.deepEqual(baseByRate(v), { 2000: 10000 }); assert.deepEqual(v.warnings, [])
  })
  it("plusieurs avoirs (moitié de A par lignes, puis 20 € HT par montant ventilé) puis solde encaissé ⇒ Σ TVA = TVA nette exacte par taux", async () => {
    const inv = await multi("2026-05-02")
    await creditLine(inv, "A20", "2026-05-03", 50) // −50 HT @20 % ⇒ −60 TTC ; reste A 50 HT @20, B 100 HT @10
    const amount = await createPartialCreditNote(db, A, inv, { kind: "AMOUNT_HT", cents: BigInt(2000) }, "remise", new Date("2026-05-04T10:00:00Z")); assert.ok(amount.ok, js(amount))
    // 20 € HT ventilés au prorata des bases nettes de l'origine ENTIÈRE (100 @20, 100 @10) : 10 @20 + 10 @10 ⇒ TVA 2 + 1 ⇒ 23 TTC.
    const notes = await db.invoice.findMany({ where: { creditedInvoiceId: inv }, select: { totalTTC: true, totalVAT: true } })
    const netTTC = 23000 - notes.reduce((s, n) => s + Number(n.totalTTC) * 100, 0)
    assert.equal(netTTC, 23000 - 6000 - 2300)
    await pay(inv, netTTC, "2026-05-12")
    const v = await enc(MAY)
    // TVA nette : 20 % : 20 − 10 − 2 = 8 ; 10 % : 10 − 1 = 9.
    assert.deepEqual(byRate(v), { 1000: 900, 2000: 800 }, js(v)); assert.deepEqual(v.warnings, [])
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: inv } })).status, "PAID")
  })
})

describe("R1 — paiement partiel avant/après l'avoir : réaffectation datée de l'avoir, période antérieure figée", () => {
  it("50 € encaissés (prorata facture pleine : 4,35 @20 + 2,17 @10), puis avoir A, puis 60 € ⇒ réaffectation à l'avoir (−4,35 @20 ; +2,38 @10) puis +5,45 @10 : total 10 @10, 0 @20", async () => {
    // Facture en juin, isolée par des périodes dédiées : paiement 1 en juin, avoir + paiement 2 en juillet.
    const JUN = [D("2026-06-01"), D("2026-06-30")] as const, JUL = [D("2026-07-01"), D("2026-07-31")] as const
    const inv = await multi("2026-06-02")
    await pay(inv, 5000, "2026-06-10")
    const jun = await enc(JUN)
    assert.deepEqual(byRate(jun), { 1000: 217, 2000: 435 }, js(jun)) // arrondi(50×20/230)=4,35 ; arrondi(50×10/230)=2,17
    const declJun = await withClock(AFTER_PERIODS, () => declareVat(db, A, JUN[0], JUN[1], "ENCAISSEMENTS")); assert.ok(declJun.ok, js(declJun))
    await creditLine(inv, "A20", "2026-07-03")
    const julAfterCredit = await enc(JUL)
    // Réaffectation datée de l'avoir : cible nette (B seul : 110 TTC, 10 TVA) pour 50 € encaissés ⇒ 4,55 @10, 0 @20 ; parts = 4,55 − 2,17 = +2,38 ; 0 − 4,35 = −4,35.
    assert.deepEqual(byRate(julAfterCredit), { 1000: 238, 2000: -435 }, js(julAfterCredit)); assert.equal(julAfterCredit.adjustments, 1); assert.equal(julAfterCredit.payments, 0)
    // Cycle R3 (réserve fiscale Codex) : la réaffectation est signalée hors contrat tant que l'expert-comptable ne l'a pas validée ⇒ la
    // déclaration de juillet est REFUSÉE ; l'aperçu reste calculé. Juin (sans réaffectation) reste déclaré.
    assert.equal(julAfterCredit.warnings.length, 1, js(julAfterCredit.warnings)); assert.match(julAfterCredit.warnings[0], /réaffectation .* en attente de validation/)
    const declJul = await withClock(AFTER_PERIODS, () => declareVat(db, A, JUL[0], JUL[1], "ENCAISSEMENTS")); assert.equal(declJul.ok, false); assert.match((declJul as { error: string }).error, /hors contrat fiscal/)
    await pay(inv, 6000, "2026-07-12")
    const jul = await enc(JUL)
    assert.deepEqual(byRate(jul), { 1000: 783, 2000: -435 }, js(jul)) // +5,45 @10 (10 − 4,55)
    assert.equal(Number(jun.collectedCents) + Number(jul.collectedCents), 1000, "Σ périodes = TVA nette (10 € @10 %)")
    // Juin figé : la déclaration enregistrée et le recalcul de juin sont inchangés par l'avoir de juillet.
    const junAgain = await enc(JUN); assert.deepEqual(byRate(junAgain), byRate(jun))
    assert.equal((await db.vatDeclaration.findUniqueOrThrow({ where: { id: declJun.ok ? declJun.value.id : "" } })).collectedCents, jun.collectedCents)
    // Mono-taux : facture 120, payée 60, avoir 50 HT (60 TTC) ⇒ aucune réaffectation (même taux) : les 10 € collectés restent.
    const AUG = [D("2026-08-01"), D("2026-08-31")] as const
    const mono = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }], { now: new Date("2026-08-02T10:00:00Z") })
    await pay(mono, 6000, "2026-08-05")
    const cn = await createPartialCreditNote(db, A, mono, { kind: "AMOUNT_HT", cents: BigInt(5000) }, "non réalisé", new Date("2026-08-20T10:00:00Z")); assert.ok(cn.ok)
    const aug = await enc(AUG); assert.deepEqual(byRate(aug), { 2000: 1000 }); assert.equal(aug.adjustments, 0, "parts nulles ⇒ aucune réaffectation comptée"); assert.deepEqual(aug.warnings, [], "mono-taux : aucune réaffectation, aucun avertissement")
  })
  it("avoir total après encaissement (hors contrat) : aucune TVA fabriquée ni réaffectation, avertissement explicite citant le montant encaissé au-delà de la facture nette", async () => {
    const SEP = [D("2026-09-01"), D("2026-09-30")] as const
    const inv = await multi("2026-09-02")
    await pay(inv, 23000, "2026-09-05")
    const before = await enc(SEP); assert.deepEqual(byRate(before), { 1000: 1000, 2000: 2000 })
    const t = await db.$transaction(async (tx) => { const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId: inv, actorId: "admA", reason: "annulation", now: new Date("2026-09-10T10:00:00Z"), nextNumber: (x) => nextDocumentNumber(x, "coA", "CREDIT_NOTE", 2026) }); if (r.ok) await flushDeferredConstraints(tx); return r }); assert.ok(t.ok, js(t))
    const after = await enc(SEP)
    assert.deepEqual(byRate(after), byRate(before), "aucune régularisation inventée"); assert.equal(after.adjustments, 0)
    assert.equal(after.warnings.length, 1); assert.match(after.warnings[0], /230\.00 € encaissés au-delà de la facture nette/); assert.match(after.warnings[0], /remboursement effectif/)
  })
})
