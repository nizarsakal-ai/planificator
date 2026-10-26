// S1 (revue Codex R2, 26/10/2026) — facture de solde : le devis lié ne peut être ni retiré ni changé tant qu'elle déduit des acomptes
// émis (sinon la liaison invoice_deposit_deductions survivrait sans ligne de déduction et le montant intégral serait émis).
// Reproduction Codex : devis 1 200 € TTC, acompte émis 360 €, conversion, updateDraftInvoice sans quoteId ⇒ désormais REFUSÉ, état
// strictement inchangé (en-tête, lignes, liaisons, journal) ; changement vers un autre devis ⇒ refusé ; émission d'un état corrompu
// par SQL (liaison sans ligne, devis NULL) ⇒ refusée par le service ET par la contrainte différée ; PDF/snapshot cohérents ;
// l'abandon du brouillon libère l'acompte, réutilisable sur une nouvelle facture de solde. Chemin Lot B (setInvoiceLines) couvert.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { parseInvoiceForm } from "@/lib/billing/invoices/invoice-schemas"
import { createDraftInvoice, issueInvoice, updateDraftInvoice } from "@/lib/billing/invoices/invoice.service"
import { INVOICE_C2_ERRORS } from "@/lib/billing/invoices/invoice-c2.core"
import { DEPOSIT_ERRORS } from "@/lib/billing/invoices/deposit.service"
import { LIFECYCLE_ERRORS, replaceDraftLinesCore, transitionInvoiceCore } from "@/lib/billing/invoice-lifecycle.core"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { buildInvoicePdfData } from "@/lib/billing/pdf/invoice-pdf"
import { A, NOW, js, seedCompanies, useTestClock } from "./helpers"
import { acceptedQuote, finalDraft, issuedDeposit } from "./fixtures"

const db = new PrismaClient()
const L = [{ designation: "Travaux", quantity: "1", unitPrice: "1000", vatRate: "20" }]
const snapshot = async (id: string) => js({
  inv: await db.invoice.findUniqueOrThrow({ where: { id }, select: { quoteId: true, status: true, totalHT: true, totalVAT: true, totalTTC: true, lines: { orderBy: { position: "asc" }, select: { designation: true, unitPrice: true, deductsDepositId: true } } } }),
  deductions: await db.invoiceDepositDeduction.findMany({ where: { finalInvoiceId: id }, orderBy: { id: "asc" }, select: { depositInvoiceId: true, amountTTCCents: true } }),
  logs: await db.historyLog.count({ where: { entityId: id } }),
})

before(async () => { useTestClock(); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db) })
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("S1 — retrait ou changement du devis d'une facture de solde avec acomptes déduits", () => {
  it("reproduction Codex : updateDraftInvoice sans quoteId ⇒ refusé « devis lié ne peut être retiré » ; état identique (rollback total) ; la facture s'émet ensuite à 840 € avec sa déduction", async () => {
    const q = await acceptedQuote(db, A, "wA", L)
    const dep = await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 3000 })
    const fin = await finalDraft(db, A, q)
    const before = await snapshot(fin)
    assert.match(before, /"deductsDepositId":"/, "déduction présente après conversion")
    const f = parseInvoiceForm({ worksiteId: "wA", lines: L }); assert.ok(f.ok); if (!f.ok) return
    assert.deepEqual(await updateDraftInvoice(db, A, fin, f.value), { ok: false, error: INVOICE_C2_ERRORS.quoteLocked })
    assert.equal(await snapshot(fin), before, "aucune mutation : en-tête, lignes, liaisons, journal inchangés")
    // Changement vers un AUTRE devis accepté : refusé de même.
    const q2 = await acceptedQuote(db, A, "wA", L)
    const f2 = parseInvoiceForm({ worksiteId: "wA", quoteId: q2, lines: L }); assert.ok(f2.ok); if (!f2.ok) return
    assert.deepEqual(await updateDraftInvoice(db, A, fin, f2.value), { ok: false, error: INVOICE_C2_ERRORS.quoteLocked })
    assert.equal(await snapshot(fin), before)
    // Modification légitime (même devis, prestations changées) : acceptée, déductions régénérées.
    const f3 = parseInvoiceForm({ worksiteId: "wA", quoteId: q, lines: [{ designation: "Travaux", quantity: "1", unitPrice: "1100", vatRate: "20" }] }); assert.ok(f3.ok); if (!f3.ok) return
    const u3 = await updateDraftInvoice(db, A, fin, f3.value); assert.ok(u3.ok, js(u3))
    const iss = await issueInvoice(db, A, fin, NOW); assert.ok(iss.ok, js(iss))
    const after = await db.invoice.findUniqueOrThrow({ where: { id: fin }, include: { lines: true, depositDeductions: true } })
    assert.equal(after.totalTTC.toString(), "960"); assert.equal(after.quoteId, q) // 1 100 − 300 HT ⇒ 800 HT, 960 TTC
    assert.equal(after.depositDeductions.length, 1); assert.equal(after.lines.filter((l) => l.deductsDepositId === dep).length, 1)
    // PDF : bloc « Acomptes déduits » cohérent avec la ligne de déduction et le total ; snapshot présent.
    const pdf = await buildInvoicePdfData(db, "coA", fin, NOW); assert.ok(pdf)
    assert.ok(pdf?.extraBlocks?.some((b) => b.title === "Acomptes déduits" && b.rows.some((r) => /360,00/.test(r))), js(pdf?.extraBlocks))
    assert.equal(pdf?.reissue?.source, "SNAPSHOT")
  })
  it("sans acompte déduit : retrait ou changement de devis autorisés (aucune liaison à protéger) ; les déductions suivent le nouveau devis", async () => {
    const q = await acceptedQuote(db, A, "wA", L)
    const fin = await finalDraft(db, A, q)
    const f = parseInvoiceForm({ worksiteId: "wA", lines: L }); assert.ok(f.ok); if (!f.ok) return
    assert.ok((await updateDraftInvoice(db, A, fin, f.value)).ok)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: fin } })).quoteId, null)
    const q2 = await acceptedQuote(db, A, "wA", L); await issuedDeposit(db, A, q2, { kind: "PERCENT", bp: 1000 })
    const f2 = parseInvoiceForm({ worksiteId: "wA", quoteId: q2, lines: L }); assert.ok(f2.ok); if (!f2.ok) return
    assert.ok((await updateDraftInvoice(db, A, fin, f2.value)).ok)
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: fin }, include: { depositDeductions: true, lines: true } })
    assert.equal(inv.quoteId, q2); assert.equal(inv.depositDeductions.length, 1); assert.equal(inv.lines.filter((l) => l.deductsDepositId).length, 1); assert.equal(inv.totalTTC.toString(), "1080")
  })
  it("état corrompu par SQL (devis NULL, lignes de déduction supprimées, liaison conservée) : émission refusée par le service (orphanDeductions) et par la contrainte différée en SQL direct", async () => {
    const q = await acceptedQuote(db, A, "wA", L)
    await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 3000 })
    const fin = await finalDraft(db, A, q)
    await db.$executeRawUnsafe(`DELETE FROM invoice_lines WHERE "invoiceId" = '${fin}' AND "deductsDepositId" IS NOT NULL`)
    await db.$executeRawUnsafe(`UPDATE invoices SET "quoteId" = NULL, "totalHT" = 1000, "totalVAT" = 200, "totalTTC" = 1200 WHERE id = '${fin}'`)
    assert.equal(await db.invoiceDepositDeduction.count({ where: { finalInvoiceId: fin } }), 1, "liaison orpheline simulée")
    assert.deepEqual(await issueInvoice(db, A, fin, NOW), { ok: false, error: DEPOSIT_ERRORS.orphanDeductions })
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: fin } })).status, "DRAFT")
    // Chemin Lot B (numéro provisoire ⇒ refus métier) puis SQL direct : la contrainte différée refuse l'émission.
    await db.$executeRawUnsafe(`UPDATE invoices SET number = 'FAC-2026-7777' WHERE id = '${fin}'`)
    await assert.rejects(db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`UPDATE invoices SET status = 'SENT', "sentAt" = now() WHERE id = '${fin}'`); await flushDeferredConstraints(tx) }), /DEPOSIT_DEDUCTION_INVALID: 1 liaison/)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: fin } })).status, "DRAFT")
    // Chemin Lot B réel (transitionInvoiceCore + flush) : même refus (même sans devis, même sans contrôle d'acomptes).
    await assert.rejects(db.$transaction(async (tx) => { const r = await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: fin, actorId: "admA", to: "SENT", now: NOW }); if (r.ok) await flushDeferredConstraints(tx); return r }), /DEPOSIT_DEDUCTION_INVALID/)
    // Ligne de déduction sans liaison (inverse) : refusée aussi.
    const q3 = await acceptedQuote(db, A, "wA", L); const dep3 = await issuedDeposit(db, A, q3, { kind: "PERCENT", bp: 3000 }); const fin3 = await finalDraft(db, A, q3)
    await db.$executeRawUnsafe(`DELETE FROM invoice_deposit_deductions WHERE "finalInvoiceId" = '${fin3}'`)
    assert.deepEqual(await issueInvoice(db, A, fin3, NOW), { ok: false, error: DEPOSIT_ERRORS.depositNotDeducted })
    await assert.rejects(db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`UPDATE invoices SET status = 'SENT', "sentAt" = now() WHERE id = '${fin3}'`); await flushDeferredConstraints(tx) }), /DEPOSIT_DEDUCTION_INVALID: 1 ligne/)
    void dep3
  })
  it("chemin Lot B : replaceDraftLinesCore refuse un brouillon de solde avec déductions (même famille #5) ; lignes de déduction supprimées par SQL ⇒ émission Lot C refusée (mismatch) et base refusée ; recalcul puis émission OK", async () => {
    const q = await acceptedQuote(db, A, "wA", L)
    await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 3000 })
    const fin = await finalDraft(db, A, q)
    const r = await db.$transaction((tx) => replaceDraftLinesCore(tx, { companyId: "coA", invoiceId: fin, actorId: "admA", lines: [{ articleId: null, designation: "Travaux", unit: "u", quantity: 1, unitPrice: 1000, vatRate: 20, lineHT: 1000, position: 0 }], totals: { totalHT: 1000, totalVAT: 200, totalTTC: 1200 } }))
    assert.deepEqual(r, { ok: false, error: LIFECYCLE_ERRORS.hasDeductions })
    await db.$executeRawUnsafe(`DELETE FROM invoice_lines WHERE "invoiceId" = '${fin}' AND "deductsDepositId" IS NOT NULL`)
    await db.$executeRawUnsafe(`UPDATE invoices SET "totalHT" = 1000, "totalVAT" = 200, "totalTTC" = 1200 WHERE id = '${fin}'`)
    assert.deepEqual(await issueInvoice(db, A, fin, NOW), { ok: false, error: DEPOSIT_ERRORS.deductionMismatch })
    await db.$executeRawUnsafe(`UPDATE invoices SET number = 'FAC-2026-7778' WHERE id = '${fin}'`)
    // Chemin Lot B : refus métier (devis porteur d'acomptes, même famille #2) ; SQL direct : la contrainte différée refuse.
    assert.deepEqual(await db.$transaction((tx) => transitionInvoiceCore(tx, { companyId: "coA", invoiceId: fin, actorId: "admA", to: "SENT", now: NOW })), { ok: false, error: LIFECYCLE_ERRORS.quoteHasDeposits })
    await assert.rejects(db.$transaction(async (tx) => { await tx.$executeRawUnsafe(`UPDATE invoices SET status = 'SENT', "sentAt" = now() WHERE id = '${fin}'`); await flushDeferredConstraints(tx) }), /DEPOSIT_DEDUCTION_INVALID: 1 liaison/)
    const f = parseInvoiceForm({ worksiteId: "wA", quoteId: q, lines: L }); assert.ok(f.ok); if (!f.ok) return
    assert.ok((await updateDraftInvoice(db, A, fin, f.value)).ok, "recalcul des déductions")
    const iss = await issueInvoice(db, A, fin, NOW); assert.ok(iss.ok, js(iss))
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: fin } })).totalTTC.toString(), "840")
  })
  it("réutilisation de l'acompte : l'abandon du brouillon de solde supprime ses liaisons ; une nouvelle facture de solde déduit à nouveau l'acompte ; une autre facture ne peut pas le déduire en parallèle", async () => {
    const q = await acceptedQuote(db, A, "wA", L)
    const dep = await issuedDeposit(db, A, q, { kind: "PERCENT", bp: 3000 })
    const fin = await finalDraft(db, A, q)
    const c = await db.$transaction(async (tx) => { const r = await transitionInvoiceCore(tx, { companyId: "coA", invoiceId: fin, actorId: "admA", to: "CANCELLED", now: NOW }); if (r.ok) await flushDeferredConstraints(tx); return r }); assert.ok(c.ok, js(c))
    assert.equal(await db.invoiceDepositDeduction.count({ where: { depositInvoiceId: dep } }), 0, "acompte libéré")
    const fin2 = await finalDraft(db, A, q)
    const inv2 = await db.invoice.findUniqueOrThrow({ where: { id: fin2 }, include: { depositDeductions: true } })
    assert.equal(inv2.depositDeductions[0]?.depositInvoiceId, dep); assert.equal(inv2.totalTTC.toString(), "840")
    const f = parseInvoiceForm({ worksiteId: "wA", quoteId: q, lines: L }); assert.ok(f.ok); if (!f.ok) return
    assert.deepEqual(await createDraftInvoice(db, A, f.value, NOW), { ok: false, error: "Ce devis est déjà lié à une facture." })
  })
})
