// T2 (revue Codex R3, 26/10/2026) — le refus fiscal « réaffectation après encaissement antérieur » est détecté STRUCTURELLEMENT :
// reproduction Codex (facture 100 HT @20 % + 100 HT @10 % ; paiement 50 € AVANT l'avoir ciblé 120 € puis paiement 60 €, tous le même
// jour) ⇒ déclaration REFUSÉE (ambiguïté : chronologie au jour non prouvée), rien de persisté ; ordre inverse prouvé (avoir J, paiement
// J+1) ⇒ aucun avertissement, oracle 10 € ; paiement antérieur prouvé (J−1) ⇒ refus « encaissement antérieur » ; import tardif antidaté
// dans une période déjà déclarée ⇒ avertissement d'écart, déclaration figée inchangée ; avoir avant tout paiement ⇒ 10 € conservé ;
// mono-taux même jour ⇒ aucune ambiguïté.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { recordPayment } from "@/lib/billing/invoices/invoice.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { computeVat } from "@/lib/accounting/c5/vat"
import { VAT_DECLARATION_ERRORS, declareVat } from "@/lib/accounting/c5/vat-declaration"
import { A, AFTER_PERIODS, D, js, seedCompanies, useTestClock, withClock } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const L2 = [{ designation: "A20", quantity: "1", unitPrice: "100", vatRate: "20" }, { designation: "B10", quantity: "1", unitPrice: "100", vatRate: "10" }]
const P = (m: number) => [D(`2026-${String(m).padStart(2, "0")}-01`), new Date(Date.UTC(2026, m, 0))] as const
const enc = (p: readonly [Date, Date]) => computeVat(db, A, p[0], p[1], "ENCAISSEMENTS")
const decl = (p: readonly [Date, Date]) => withClock(AFTER_PERIODS, () => declareVat(db, A, p[0], p[1], "ENCAISSEMENTS"))
const byRate = (v: { collected: { vatRateBp: number; vatCents: bigint }[] }) => Object.fromEntries(v.collected.map((r) => [r.vatRateBp, Number(r.vatCents)]))
const pay = (inv: string, cents: number, day: string) => recordPayment(db, A, inv, { amountCents: BigInt(cents), method: "TRANSFER", paidAt: D(day), reference: null, notes: null }, new Date(`${day}T12:00:00Z`)).then((r) => { if (!r.ok) throw new Error(r.error); return r.value })
const creditA = async (inv: string, day: string) => { const line = await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv, designation: "A20" } }); const r = await createPartialCreditNote(db, A, inv, { kind: "LINES", items: [{ lineId: line.id, quantityHundredths: BigInt(100) }] }, "annulation A", new Date(`${day}T10:00:00Z`)); if (!r.ok) throw new Error(r.error); return r.value }
const persisted = async () => ({ declarations: await db.vatDeclaration.count({ where: { companyId: "coA" } }), logs: await db.historyLog.count({ where: { companyId: "coA", entityType: "VatDeclaration" } }) })

before(async () => { useTestClock(); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("T2 — même jour ambigu, encaissement antérieur prouvé, ordre inverse prouvé", () => {
  it("reproduction Codex (mars) : paiement 50 → avoir A → paiement 60, tous le 10 mars ⇒ avertissement d'ambiguïté, déclaration refusée, rien de persisté ; le montant calculé (10 €) n'est pas contesté", async () => {
    const inv = await issuedInvoice(db, A, "wA", L2, { now: new Date("2026-03-02T10:00:00Z") })
    await pay(inv, 5000, "2026-03-10"); await creditA(inv, "2026-03-10"); await pay(inv, 6000, "2026-03-10")
    const v = await enc(P(3))
    assert.equal(v.collectedCents, BigInt(1000)); assert.deepEqual(byRate(v), { 1000: 1000 })
    assert.equal(v.warnings.length, 1, js(v.warnings)); assert.match(v.warnings[0], /le même jour \(2026-03-10\) : chronologie encaissement\/avoir non prouvée/)
    const before = await persisted()
    const r = await decl(P(3)); assert.equal(r.ok, false); assert.ok((r as { error: string }).error.startsWith(VAT_DECLARATION_ERRORS.outOfContract), js(r))
    assert.deepEqual(await persisted(), before, "aucune déclaration ni journal persistés")
  })
  it("ordre inverse PROUVÉ (avril) : avoir le 10, encaissements les 11 et 12 ⇒ aucun avertissement, 10 € au taux 10 %, déclaration acceptée", async () => {
    const inv = await issuedInvoice(db, A, "wA", L2, { now: new Date("2026-04-02T10:00:00Z") })
    await creditA(inv, "2026-04-10"); await pay(inv, 5000, "2026-04-11"); await pay(inv, 6000, "2026-04-12")
    const v = await enc(P(4)); assert.deepEqual(v.warnings, []); assert.deepEqual(byRate(v), { 1000: 1000 })
    const r = await decl(P(4)); assert.ok(r.ok, js(r))
  })
  it("encaissement antérieur PROUVÉ (mai) : paiement le 9, avoir le 10 ⇒ avertissement « encaissement antérieur » même si l'allocation nette ne change rien ; ordre d'enregistrement inverse (import antidaté) ⇒ même détection", async () => {
    const inv = await issuedInvoice(db, A, "wA", L2, { now: new Date("2026-05-02T10:00:00Z") })
    await pay(inv, 5000, "2026-05-09"); await creditA(inv, "2026-05-10"); await pay(inv, 6000, "2026-05-11")
    const v = await enc(P(5)); assert.ok(v.warnings.some((w) => /après encaissement antérieur/.test(w)), js(v.warnings)); assert.equal((await decl(P(5))).ok, false)
    // Import tardif antidaté (juin) : l'avoir est enregistré d'abord, le paiement ensuite mais daté AVANT l'avoir ⇒ la chronologie métier (dates) l'emporte sur l'ordre d'enregistrement.
    const inv2 = await issuedInvoice(db, A, "wA", L2, { now: new Date("2026-06-02T10:00:00Z") })
    await creditA(inv2, "2026-06-15"); await pay(inv2, 5000, "2026-06-05"); await pay(inv2, 6000, "2026-06-16")
    const v2 = await enc(P(6)); assert.ok(v2.warnings.some((w) => /après encaissement antérieur/.test(w)), js(v2.warnings)); assert.equal((await decl(P(6))).ok, false)
  })
  it("période déjà déclarée (juillet) : paiement antidaté saisi après la déclaration ⇒ avertissement d'écart, déclaration figée inchangée, nouvelle déclaration refusée (déjà déclarée)", async () => {
    const inv = await issuedInvoice(db, A, "wA", L2, { now: new Date("2026-07-02T10:00:00Z") })
    await pay(inv, 11500, "2026-07-10")
    const d = await decl(P(7)); assert.ok(d.ok, js(d)); if (!d.ok) return
    const stored = await db.vatDeclaration.findUniqueOrThrow({ where: { id: d.value.id } })
    await pay(inv, 11500, "2026-07-20") // saisi après la déclaration, daté dans la période
    const v = await enc(P(7)); assert.ok(v.warnings.some((w) => /Période déjà déclarée/.test(w)), js(v.warnings)); assert.equal(v.collectedCents, BigInt(3000))
    assert.deepEqual(await decl(P(7)), { ok: false, error: VAT_DECLARATION_ERRORS.alreadyDeclared })
    assert.equal((await db.vatDeclaration.findUniqueOrThrow({ where: { id: d.value.id } })).collectedCents, stored.collectedCents, "déclaration figée jamais réécrite")
  })
  it("avoir avant tout paiement (août, oracle 10 €) et mono-taux même jour (septembre) : aucun avertissement, déclarations acceptées", async () => {
    const inv = await issuedInvoice(db, A, "wA", L2, { now: new Date("2026-08-02T10:00:00Z") })
    await creditA(inv, "2026-08-03"); await pay(inv, 11000, "2026-08-12")
    const v = await enc(P(8)); assert.deepEqual(v.warnings, []); assert.deepEqual(byRate(v), { 1000: 1000 }); assert.ok((await decl(P(8))).ok)
    const mono = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }], { now: new Date("2026-09-02T10:00:00Z") })
    await pay(mono, 6000, "2026-09-10")
    const cn = await createPartialCreditNote(db, A, mono, { kind: "AMOUNT_HT", cents: BigInt(5000) }, "remise", new Date("2026-09-10T10:00:00Z")); assert.ok(cn.ok)
    const m = await enc(P(9)); assert.deepEqual(m.warnings, [], "mono-taux : aucune réaffectation possible ⇒ pas d'ambiguïté"); assert.deepEqual(byRate(m), { 2000: 1000 }); assert.ok((await decl(P(9))).ok)
  })
})
