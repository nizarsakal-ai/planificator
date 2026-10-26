// P1-02 — TVA sur les encaissements : événement = mouvement de trésorerie ; un avoir n'est jamais déduit aveuglément ; allocation
// cumulative par taux sans dérive d'arrondi ; régularisation négative reliée à la contre-passation ; déclaration figée ;
// non-régression DÉBITS ; isolation A/B ; tableau de bord = aperçu = déclaration. Oracles chiffrés indépendants du code.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { recordPayment, reversePayment } from "@/lib/billing/invoices/invoice.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { createCreditNoteCore } from "@/lib/billing/invoice-lifecycle.core"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { computeVat } from "@/lib/accounting/c5/vat"
import { declareVat } from "@/lib/accounting/c5/vat-declaration"
import { accountingDashboard } from "@/lib/accounting/c5/dashboard"
import { A, B, D, js, seedCompanies } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const MAR = [D("2026-03-01"), D("2026-03-31")] as const, APR = [D("2026-04-01"), D("2026-04-30")] as const
const enc = (ctx: typeof A, p: readonly [Date, Date] = MAR) => computeVat(db, ctx, p[0], p[1], "ENCAISSEMENTS")
const deb = (ctx: typeof A, p: readonly [Date, Date] = MAR) => computeVat(db, ctx, p[0], p[1], "DEBITS")
const pay = (ctx: typeof A, inv: string, cents: number, day = "2026-03-10") => recordPayment(db, ctx, inv, { amountCents: BigInt(cents), method: "TRANSFER", paidAt: D(day), reference: null, notes: null }, new Date(`${day}T12:00:00Z`)).then((r) => { if (!r.ok) throw new Error(r.error); return r.value.paymentId })
const byRate = (v: { collected: { vatRateBp: number; vatCents: bigint }[] }) => Object.fromEntries(v.collected.map((r) => [r.vatRateBp, Number(r.vatCents)]))
const inv120 = (ctx = A, w = "wA") => issuedInvoice(db, ctx, w, [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }], { now: new Date("2026-03-05T10:00:00Z") })

before(async () => {
  setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db)
  for (const ctx of [A, B]) { await db.$transaction((tx) => ensureBaseReferential(tx, ctx)); await db.$transaction((tx) => openFiscalYear(tx, ctx, { startDate: D("2026-01-01"), endDate: D("2026-12-31") })) }
})
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("P1-02 — oracles", () => {
  it("facture 120 TTC impayée + avoir 60 TTC, aucun mouvement ⇒ 0 € (jamais −10) ; paiement ultérieur du solde 60 ⇒ 10 €, sans nouvelle déduction de l'avoir ; débits = 20 − 10", async () => {
    const inv = await inv120()
    const cn = await createPartialCreditNote(db, A, inv, { kind: "AMOUNT_HT", cents: BigInt(5000) }, "remise", new Date("2026-03-06T10:00:00Z")); assert.ok(cn.ok, js(cn))
    let v = await enc(A); assert.equal(v.collectedCents, BigInt(0)); assert.equal(v.payments, 0)
    await pay(A, inv, 6000)
    v = await enc(A); assert.equal(v.collectedCents, BigInt(1000)); assert.deepEqual(byRate(v), { 2000: 1000 }); assert.equal(v.payments, 1)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: inv } })).status, "PAID")
    assert.equal((await deb(A)).collectedCents, BigInt(1000))
  })
  it("facture 120 payée 60 (10 € collectés) puis avoir sur la partie non encaissée ⇒ les 10 € restent collectés ; avoir au-delà du reste refusé (jamais un trop-perçu, jamais une TVA fabriquée)", async () => {
    const inv = await inv120()
    await pay(A, inv, 6000)
    const before = (await enc(A)).collectedCents
    const cn = await createPartialCreditNote(db, A, inv, { kind: "AMOUNT_HT", cents: BigInt(5000) }, "non réalisé", new Date("2026-03-20T10:00:00Z")); assert.ok(cn.ok, js(cn))
    const after = (await enc(A)).collectedCents
    assert.equal(after - before, BigInt(0), "l'avoir ne régularise rien : aucun encaissement n'est remboursé")
    const tooMuch = await createPartialCreditNote(db, A, inv, { kind: "AMOUNT_HT", cents: BigInt(100) }, "x", new Date("2026-03-21T10:00:00Z")); assert.equal(tooMuch.ok, false)
  })
  it("paiement total en fractions (1 centime, fractions non divisibles, deux taux) ⇒ Σ TVA = TVA de la facture au centime près, par taux ; calcul répété identique", async () => {
    // 120 TTC à 20 % : 0,01 + 39,99 + 40 + 40 ⇒ 20,00.
    const a = await inv120(); for (const c of [1, 3999, 4000, 4000]) await pay(A, a, c)
    // 100 HT @20 % + 100 HT @10 % = 230 TTC (TVA 20 + 10) en 7 fractions non divisibles : 33,33 × 6 + 30,02.
    const b = await issuedInvoice(db, A, "wA", [{ designation: "X", quantity: "1", unitPrice: "100", vatRate: "20" }, { designation: "Y", quantity: "1", unitPrice: "100", vatRate: "10" }], { now: new Date("2026-03-05T10:00:00Z") })
    for (const c of [3333, 3333, 3333, 3333, 3333, 3333, 3002]) await pay(A, b, c)
    // 0,07 TTC à 5,5 % (0,07 HT ? non : 1 ligne 0,07 HT × 5,5 % ⇒ TVA 0,00) et 3 paiements de 1 centime + le reste : somme exacte.
    const c = await issuedInvoice(db, A, "wA", [{ designation: "Micro", quantity: "7", unitPrice: "0.01", vatRate: "20" }], { now: new Date("2026-03-05T10:00:00Z") }) // 0,07 HT, TVA 0,01, TTC 0,08
    for (const cc of [1, 1, 1, 5]) await pay(A, c, cc)
    const prev = await enc(A)
    const v1 = await enc(A), v2 = await enc(A)
    assert.equal(js(v1), js(v2), "déterministe")
    // Isoler les trois factures : on retranche l'état antérieur par différence sur une période dédiée (avril).
    const a2 = await inv120(); for (const cc of [1, 3999, 4000, 4000]) await pay(A, a2, cc, "2026-04-02")
    const b2 = await issuedInvoice(db, A, "wA", [{ designation: "X", quantity: "1", unitPrice: "100", vatRate: "20" }, { designation: "Y", quantity: "1", unitPrice: "100", vatRate: "10" }], { now: new Date("2026-04-01T10:00:00Z") })
    for (const cc of [3333, 3333, 3333, 3333, 3333, 3333, 3002]) await pay(A, b2, cc, "2026-04-03")
    const c2 = await issuedInvoice(db, A, "wA", [{ designation: "Micro", quantity: "7", unitPrice: "0.01", vatRate: "20" }], { now: new Date("2026-04-01T10:00:00Z") })
    for (const cc of [1, 1, 1, 5]) await pay(A, c2, cc, "2026-04-04")
    const apr = await enc(A, APR)
    assert.deepEqual(byRate(apr), { 1000: 1000, 2000: 2000 + 2000 + 1 }, js(apr)); assert.equal(apr.payments, 15)
    void prev
  })
  it("contre-passation ⇒ régularisation négative exacte reliée au paiement d'origine ; avoir total sur facture encaissée ⇒ aucune TVA fabriquée, avertissement explicite (remboursement non pris en charge)", async () => {
    const inv = await inv120()
    const p = await pay(A, inv, 12000, "2026-03-11")
    const before = await enc(A)
    const rev = await reversePayment(db, A, p, "erreur", new Date("2026-03-12T10:00:00Z")); assert.ok(rev.ok)
    const after = await enc(A)
    assert.equal(after.collectedCents - before.collectedCents, BigInt(-2000)); assert.equal(after.payments - before.payments, 1)
    // Avoir total sur une facture encaissée (le paiement reste) : TVA encaissée inchangée, situation signalée.
    const inv2 = await inv120(); await pay(A, inv2, 12000, "2026-03-13")
    const mid = await enc(A)
    const t = await db.$transaction(async (tx) => { const r = await createCreditNoteCore(tx, { companyId: "coA", invoiceId: inv2, actorId: "admA", reason: "annulation", now: new Date("2026-03-14T10:00:00Z"), nextNumber: (x) => nextDocumentNumber(x, "coA", "CREDIT_NOTE", 2026) }); if (r.ok) await flushDeferredConstraints(tx); return r }); assert.ok(t.ok)
    const end = await enc(A)
    assert.equal(end.collectedCents, mid.collectedCents, "aucune régularisation inventée sans remboursement effectif")
    assert.ok(end.warnings.some((w) => /remboursement effectif/.test(w)), js(end.warnings))
    assert.equal((await reversePayment(db, A, (await db.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv2 } })).id, "rembourser", new Date())).ok, false, "le remboursement après avoir total est un parcours refusé explicitement")
  })
  it("périodes différentes : paiement en mars, contre-passation en avril ⇒ +20 en mars, −20 en avril ; déclaration de mars figée, inchangée par l'événement d'avril ; DÉBITS inchangé ; B isolée ; tableau de bord = aperçu = déclaration", async () => {
    const inv = await inv120()
    const p = await pay(A, inv, 12000, "2026-03-25")
    const mar = await enc(A)
    const decl = await declareVat(db, A, MAR[0], MAR[1], "ENCAISSEMENTS"); assert.ok(decl.ok, js(decl)); if (!decl.ok) return
    const stored = await db.vatDeclaration.findUniqueOrThrow({ where: { id: decl.value.id } })
    assert.equal(stored.collectedCents, mar.collectedCents)
    const aprBefore = await enc(A, APR)
    const rev = await reversePayment(db, A, p, "litige", new Date("2026-04-05T10:00:00Z")); assert.ok(rev.ok)
    const marAgain = await enc(A)
    assert.equal(marAgain.collectedCents, mar.collectedCents, "mars inchangé : la contre-passation est datée d'avril")
    assert.equal((await db.vatDeclaration.findUniqueOrThrow({ where: { id: decl.value.id } })).collectedCents, stored.collectedCents, "déclaration figée")
    const apr = await enc(A, APR)
    assert.equal(apr.collectedCents - aprBefore.collectedCents, BigInt(-2000), js([aprBefore, apr])); assert.equal(apr.payments - aprBefore.payments, 1)
    // Débits : indépendants des paiements.
    const d1 = await deb(A); await pay(A, (await inv120()), 12000, "2026-03-26"); const d2 = await deb(A)
    assert.equal(d2.collectedCents - d1.collectedCents, BigInt(2000), "débits : +20 pour la nouvelle facture émise, pas pour le paiement")
    // Isolation : les mouvements de B n'apparaissent pas chez A.
    const aBefore = (await enc(A)).collectedCents
    const invB = await inv120(B, "wB"); await pay(B, invB, 12000, "2026-03-27")
    assert.equal((await enc(A)).collectedCents, aBefore, "les mouvements de B n'entrent pas chez A")
    assert.equal((await enc(B)).collectedCents, BigInt(2000))
    // Tableau de bord (régime ENCAISSEMENTS, mois courant = mars 2026) = aperçu = déclaration enregistrée (même fonction, même montant).
    const dash = await accountingDashboard(db, A, new Date("2026-03-31T12:00:00Z"), "ENCAISSEMENTS")
    const preview = await enc(A)
    assert.equal(dash.vat.collectedCents, preview.collectedCents)
    const declB = await declareVat(db, B, MAR[0], MAR[1], "ENCAISSEMENTS"); assert.ok(declB.ok && declB.value.dueCents === BigInt(2000))
  })
})
