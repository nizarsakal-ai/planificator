// U1 (revue Codex R4, 26/10/2026) — le refus fiscal porte sur l'HISTORIQUE de la facture : un avoir ciblé hors contrat (réaffectation après
// encaissement antérieur, ou même jour ambigu) rend hors contrat TOUS les mouvements ultérieurs de la facture, dans toutes les périodes
// suivantes (mars refusé ⇒ avril refusé), sans toucher aux périodes antérieures, aux autres factures ni aux autres sociétés. Rien n'est
// persisté en cas de refus. Contrat explicite : un encaissement intégralement contre-passé AVANT l'avoir n'est pas un encaissement conservé.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { recordPayment, reversePayment } from "@/lib/billing/invoices/invoice.service"
import { createPartialCreditNote } from "@/lib/billing/invoices/credit-note.service"
import { computeVat } from "@/lib/accounting/c5/vat"
import { VAT_DECLARATION_ERRORS, declareVat } from "@/lib/accounting/c5/vat-declaration"
import { A, AFTER_PERIODS, B, D, js, seedCompanies, useTestClock, withClock } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const L2 = [{ designation: "A20", quantity: "1", unitPrice: "100", vatRate: "20" }, { designation: "B10", quantity: "1", unitPrice: "100", vatRate: "10" }]
const P = (y: number, m: number) => [D(`${y}-${String(m).padStart(2, "0")}-01`), new Date(Date.UTC(y, m, 0))] as const
type Ctx = typeof A
const enc = (p: readonly [Date, Date], ctx: Ctx = A) => computeVat(db, ctx, p[0], p[1], "ENCAISSEMENTS")
const decl = (p: readonly [Date, Date], ctx: Ctx = A) => withClock(AFTER_PERIODS, () => declareVat(db, ctx, p[0], p[1], "ENCAISSEMENTS"))
const byRate = (v: { collected: { vatRateBp: number; vatCents: bigint }[] }) => Object.fromEntries(v.collected.map((r) => [r.vatRateBp, Number(r.vatCents)]))
const pay = (inv: string, cents: number, day: string, ctx: Ctx = A) => recordPayment(db, ctx, inv, { amountCents: BigInt(cents), method: "TRANSFER", paidAt: D(day), reference: null, notes: null }, new Date(`${day}T12:00:00Z`)).then((r) => { if (!r.ok) throw new Error(r.error); return r.value })
const creditA = async (inv: string, day: string) => { const line = await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: inv, designation: "A20" } }); const r = await createPartialCreditNote(db, A, inv, { kind: "LINES", items: [{ lineId: line.id, quantityHundredths: BigInt(100) }] }, "annulation A", new Date(`${day}T10:00:00Z`)); if (!r.ok) throw new Error(r.error); return r.value }
const reverse = async (paymentId: string, day: string) => { const at = new Date(`${day}T10:00:00Z`); useTestClock(at); try { const r = await reversePayment(db, A, paymentId, "erreur", at); if (!r.ok) throw new Error(r.error) } finally { useTestClock() } }
const inv2 = (day: string, ctx: Ctx = A, w = "wA") => issuedInvoice(db, ctx, w, L2, { now: new Date(`${day}T10:00:00Z`) })
const persisted = async (c = "coA") => ({ declarations: await db.vatDeclaration.count({ where: { companyId: c } }), logs: await db.historyLog.count({ where: { companyId: c, entityType: "VatDeclaration" } }) })
const refused = async (p: readonly [Date, Date], re: RegExp, ctx: Ctx = A) => { const v = await enc(p, ctx); assert.ok(v.warnings.some((w) => re.test(w)), js(v.warnings)); const before = await persisted(ctx.companyId); const r = await decl(p, ctx); assert.equal(r.ok, false, js(r)); assert.ok((r as { error: string }).error.startsWith(VAT_DECLARATION_ERRORS.outOfContract), js(r)); assert.deepEqual(await persisted(ctx.companyId), before, "refus sans déclaration ni journal"); return v }
const accepted = async (p: readonly [Date, Date], ctx: Ctx = A) => { const v = await enc(p, ctx); assert.deepEqual(v.warnings, [], js(v.warnings)); const r = await decl(p, ctx); assert.ok(r.ok, js(r)); return v }
const DEP = /ventilation de la TVA par taux dépendante de la réaffectation non validée/

before(async () => { useTestClock(); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("U1 — le refus fiscal suit l'historique de la facture dans les périodes ultérieures", () => {
  it("reproduction Codex : paiement 50 le 9 mars, avoir ciblé le 10 mars, règlement 60 le 10 avril ⇒ mars ET avril refusés ; le montant d'avril (545 c) n'est pas contesté ; aucune déclaration ni journal", async () => {
    const inv = await inv2("2026-03-02")
    await pay(inv, 5000, "2026-03-09"); await creditA(inv, "2026-03-10"); await pay(inv, 6000, "2026-04-10")
    const mar = await refused(P(2026, 3), /après encaissement antérieur/); assert.equal(mar.adjustments, 1)
    const apr = await refused(P(2026, 4), DEP); assert.equal(apr.collectedCents, BigInt(545)); assert.equal(apr.warnings.length, 1, js(apr.warnings)); assert.match(apr.warnings[0], /1 mouvement\(s\) de trésorerie de la facture FAC-2026-0001 .*\(avoir AV-2026-0001 du 2026-03-10, après encaissement antérieur\)/)
    assert.deepEqual(await persisted(), { declarations: 0, logs: 0 })
  })
  it("même jour ambigu en mai (paiement 50 et avoir le 10), règlement 60 en juin ⇒ mai refusé (ambiguïté) et juin refusé (dépendance « même jour »)", async () => {
    const inv = await inv2("2026-05-02")
    await pay(inv, 5000, "2026-05-10"); await creditA(inv, "2026-05-10"); await pay(inv, 6000, "2026-06-15")
    const may = await refused(P(2026, 5), /le même jour \(2026-05-10\)/); assert.equal(may.warnings.length, 1, "l'avoir dans la période explique déjà le refus : pas de doublon")
    await refused(P(2026, 6), /dépendante .* le même jour qu'un encaissement/)
  })
  it("paiement en février 2025, avoir en mars, règlements fractionnés en avril, mai et janvier 2026 (bornes d'exercice franchies) : février déclarable (non concerné), toutes les périodes suivantes refusées", async () => {
    const inv = await inv2("2025-02-02")
    await pay(inv, 5000, "2025-02-10"); await creditA(inv, "2025-03-10"); await pay(inv, 3000, "2025-04-05"); await pay(inv, 2000, "2025-05-05"); await pay(inv, 1000, "2026-01-15")
    const feb = await accepted(P(2025, 2)); assert.deepEqual(byRate(feb), { 2000: 435, 1000: 217 }, "prorata de la facture pleine, indépendant de l'avoir postérieur")
    await refused(P(2025, 3), /après encaissement antérieur/)
    for (const p of [P(2025, 4), P(2025, 5), P(2026, 1)]) await refused(p, DEP)
    assert.equal((await persisted()).declarations, 1, "seule février est figée")
  })
  it("contrat explicite — encaissement intégralement contre-passé AVANT l'avoir : net antérieur nul ⇒ avoir « avant tout encaissement », oracle 10 €, périodes déclarables ; contre-passation APRÈS l'avoir ⇒ mouvement dépendant, période refusée", async () => {
    const inv = await inv2("2025-07-02")
    const p = await pay(inv, 5000, "2025-07-10"); await reverse(p.paymentId, "2025-07-20"); await creditA(inv, "2025-08-10"); await pay(inv, 11000, "2025-09-10")
    const jul = await accepted(P(2025, 7)); assert.equal(jul.collectedCents, BigInt(0), "paiement et contre-passation s'annulent exactement")
    const aug = await accepted(P(2025, 8)); assert.equal(aug.adjustments, 0, "aucune réaffectation : rien n'était conservé")
    const sep = await accepted(P(2025, 9)); assert.deepEqual(byRate(sep), { 1000: 1000 }, "oracle 10 € @10 %")
    // Variante : la contre-passation suit l'avoir ⇒ l'encaissement était conservé à la date de l'avoir (réaffectation) et la contre-passation en dépend.
    const inv2b = await inv2("2025-10-02")
    const p2 = await pay(inv2b, 5000, "2025-10-05"); await creditA(inv2b, "2025-10-10"); await reverse(p2.paymentId, "2025-11-05")
    await refused(P(2025, 10), /après encaissement antérieur/); await refused(P(2025, 11), DEP)
  })
  it("avoir avant tout paiement (mars 2024) puis règlement en avril : oracle 10 € @10 % conservé, les deux périodes déclarables", async () => {
    const inv = await inv2("2024-03-02")
    await creditA(inv, "2024-03-05"); await pay(inv, 11000, "2024-04-10")
    const mar = await accepted(P(2024, 3)); assert.equal(mar.collectedCents, BigInt(0))
    const apr = await accepted(P(2024, 4)); assert.deepEqual(byRate(apr), { 1000: 1000 })
  })
  it("absence de blocage indu : facture mono-taux et facture sans lien de la même société, société B — non concernées ; la période d'août de A est refusée pour la seule facture dépendante ; deux déclarations simultanées refusées sans effet persistant", async () => {
    const tainted = await inv2("2026-07-02"); await pay(tainted, 5000, "2026-07-09"); await creditA(tainted, "2026-07-10"); await pay(tainted, 6000, "2026-08-10")
    const mono = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }], { now: new Date("2026-08-02T10:00:00Z") }); await pay(mono, 12000, "2026-08-12")
    const other = await inv2("2026-08-02"); await pay(other, 23000, "2026-08-13")
    const invB = await inv2("2026-08-02", B, "wB"); await pay(invB, 23000, "2026-08-14", B)
    const aug = await refused(P(2026, 8), DEP); assert.equal(aug.warnings.length, 1, "une seule facture concernée"); assert.match(aug.warnings[0], /facture FAC-2026-0003 /)
    const before = await persisted()
    const [r1, r2] = await Promise.all([decl(P(2026, 8)), decl(P(2026, 8))]); assert.equal(r1.ok, false); assert.equal(r2.ok, false)
    assert.deepEqual(await persisted(), before)
    const b = await accepted(P(2026, 8), B); assert.deepEqual(byRate(b), { 2000: 2000, 1000: 1000 })
  })
  it("période déjà déclarée puis avoir antidaté saisi après coup : septembre 2024 refusé (encaissement antérieur), octobre déjà déclaré signale l'écart et la dépendance, déclaration figée jamais réécrite — le reste relève de l'expert-comptable", async () => {
    const inv = await inv2("2024-09-02"); await pay(inv, 5000, "2024-09-09"); await pay(inv, 6000, "2024-10-10")
    const d = await decl(P(2024, 10)); assert.ok(d.ok, js(d)); if (!d.ok) return
    const stored = await db.vatDeclaration.findUniqueOrThrow({ where: { id: d.value.id } })
    await creditA(inv, "2024-09-10") // antidaté, saisi après la déclaration d'octobre
    await refused(P(2024, 9), /après encaissement antérieur/)
    const oct = await enc(P(2024, 10)); assert.ok(oct.warnings.some((w) => DEP.test(w)), js(oct.warnings)); assert.ok(oct.warnings.some((w) => /diffère de la déclaration figée/.test(w)), js(oct.warnings))
    assert.deepEqual(await decl(P(2024, 10)), { ok: false, error: VAT_DECLARATION_ERRORS.alreadyDeclared })
    assert.equal((await db.vatDeclaration.findUniqueOrThrow({ where: { id: d.value.id } })).collectedCents, stored.collectedCents)
  })
})
