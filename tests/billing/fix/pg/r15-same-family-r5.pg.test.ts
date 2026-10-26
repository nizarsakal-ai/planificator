// Cycle R5 — défauts de MÊME FAMILLE que U1 (détection bornée à la fenêtre calculée alors que l'effet porte sur les périodes suivantes) :
// (1) un encaissement saisi APRÈS la déclaration de la période qui le contient (paiement antidaté) n'est jamais déclaré ; l'allocation
// cumulative des mouvements ultérieurs de la même facture en dépend ⇒ leurs périodes sont refusées (pas seulement l'aperçu de la période
// déclarée) ; (2) régime de TVA unique par société : la base d'une nouvelle déclaration doit être celle des déclarations existantes.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { recordPayment } from "@/lib/billing/invoices/invoice.service"
import { computeVat } from "@/lib/accounting/c5/vat"
import { VAT_DECLARATION_ERRORS, declareVat } from "@/lib/accounting/c5/vat-declaration"
import { A, AFTER_PERIODS, B, D, js, seedCompanies, useTestClock, withClock } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const L2 = [{ designation: "A20", quantity: "1", unitPrice: "100", vatRate: "20" }, { designation: "B10", quantity: "1", unitPrice: "100", vatRate: "10" }]
const P = (y: number, m: number) => [D(`${y}-${String(m).padStart(2, "0")}-01`), new Date(Date.UTC(y, m, 0))] as const
type Ctx = typeof A
const enc = (p: readonly [Date, Date], ctx: Ctx = A) => computeVat(db, ctx, p[0], p[1], "ENCAISSEMENTS")
const decl = (p: readonly [Date, Date], basis: "ENCAISSEMENTS" | "DEBITS" = "ENCAISSEMENTS", ctx: Ctx = A) => withClock(AFTER_PERIODS, () => declareVat(db, ctx, p[0], p[1], basis))
const pay = (inv: string, cents: number, day: string, enteredAt = `${day}T12:00:00Z`, ctx: Ctx = A) => recordPayment(db, ctx, inv, { amountCents: BigInt(cents), method: "TRANSFER", paidAt: D(day), reference: null, notes: null }, new Date(enteredAt)).then((r) => { if (!r.ok) throw new Error(r.error); return r.value })
const persisted = async (c: string) => ({ declarations: await db.vatDeclaration.count({ where: { companyId: c } }), logs: await db.historyLog.count({ where: { companyId: c, entityType: "VatDeclaration" } }) })

before(async () => { useTestClock(); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("même famille U1 — encaissement saisi après la déclaration de sa période : les périodes suivantes de la facture sont refusées", () => {
  it("février déclaré (115 €) ; paiement de 50 € daté du 20/02 saisi le 05/03 ; 65 € le 15/03 ⇒ mars refusé (allocation dépendante d'un encaissement jamais déclaré), rien de persisté ; février figé inchangé et signalé ; société B et facture sans lien non bloquées", async () => {
    const inv = await issuedInvoice(db, A, "wA", L2, { now: new Date("2026-02-02T10:00:00Z") })
    await pay(inv, 11500, "2026-02-10")
    const feb = await decl(P(2026, 2)); assert.ok(feb.ok, js(feb)); if (!feb.ok) return
    const stored = await db.vatDeclaration.findUniqueOrThrow({ where: { id: feb.value.id } })
    useTestClock(new Date("2026-03-05T12:00:00Z")); await pay(inv, 5000, "2026-02-20", "2026-03-05T12:00:00Z"); useTestClock() // antidaté dans une période déclarée
    await pay(inv, 6500, "2026-03-15")
    const other = await issuedInvoice(db, A, "wA", L2, { now: new Date("2026-03-02T10:00:00Z") }); await pay(other, 23000, "2026-03-16")
    const mar = await enc(P(2026, 3))
    assert.equal(mar.warnings.length, 1, js(mar.warnings)); assert.match(mar.warnings[0], /1 événement\(s\) de la facture FAC-2026-0001 .*encaissement du 2026-02-20 saisi après la déclaration de la période 2026-02-01 → 2026-02-28/)
    const before = await persisted("coA")
    const r = await decl(P(2026, 3)); assert.equal(r.ok, false); assert.ok((r as { error: string }).error.startsWith(VAT_DECLARATION_ERRORS.outOfContract), js(r))
    assert.deepEqual(await persisted("coA"), before)
    const febNow = await enc(P(2026, 2)); assert.ok(febNow.warnings.some((w) => /Période déjà déclarée .*paiements 1/.test(w)), js(febNow.warnings))
    assert.equal((await db.vatDeclaration.findUniqueOrThrow({ where: { id: feb.value.id } })).collectedCents, stored.collectedCents, "déclaration figée jamais réécrite")
    // Société B : même mois, aucun lien ⇒ déclarable.
    const invB = await issuedInvoice(db, B, "wB", L2, { now: new Date("2026-03-02T10:00:00Z") }); await pay(invB, 23000, "2026-03-10", undefined, B)
    const b = await decl(P(2026, 3), "ENCAISSEMENTS", B); assert.ok(b.ok, js(b))
  })
})

describe("Codex — la dépendance tardive couvre aussi les avoirs ultérieurs", () => {
  it("un paiement de novembre saisi après déclaration interdit aussi l'avoir de décembre dépendant, sans écriture", async () => {
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "mono", quantity: "1", unitPrice: "100", vatRate: "20" }], { now: new Date("2023-11-02T10:00:00Z") })
    const nov = await decl(P(2023, 11)); assert.ok(nov.ok, js(nov))
    useTestClock(new Date("2026-10-26T12:00:00Z"))
    try { await pay(inv, 1500, "2023-11-10", "2026-10-26T12:00:00Z") } finally { useTestClock() }
    const credit = await createPartialCreditNote(db, A, inv, { kind: "AMOUNT_HT", cents: BigInt(5000) }, "correction", new Date("2023-12-10T10:00:00Z"))
    assert.ok(credit.ok, js(credit))
    const v = await enc(P(2023, 12)); assert.ok(v.warnings.some(w => /allocation cumulative dépendante/.test(w)), js(v.warnings))
    const before = await persisted("coA")
    const r = await decl(P(2023, 12)); assert.equal(r.ok, false, js(r)); assert.deepEqual(await persisted("coA"), before)
  })
})

describe("même famille — régime de TVA unique par société", () => {
  it("société B : encaissements en mars ⇒ une déclaration d'avril en DÉBITS est refusée (message nommant la base existante), rien de persisté ; en ENCAISSEMENTS elle est acceptée", async () => {
    const before = await persisted("coB")
    const mixed = await decl(P(2026, 4), "DEBITS", B); assert.equal(mixed.ok, false); assert.match((mixed as { error: string }).error, /Régime de TVA unique par société .*encaissements, ex\. 2026-03-01 → 2026-03-31/)
    assert.deepEqual(await persisted("coB"), before)
    const ok = await decl(P(2026, 4), "ENCAISSEMENTS", B); assert.ok(ok.ok, js(ok))
  })
})
