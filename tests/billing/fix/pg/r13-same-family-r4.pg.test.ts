// Cycle R4 — défauts de MÊME FAMILLE que T1/T2 relevés par l'audit interne et corrigés :
// T2 #1 rapprochement automatique fournisseur : montant seul insuffisant (référence/libellé ou date requis) ; T2 #2 pièce convoitée par
// plusieurs opérations ⇒ aucune rapprochée automatiquement (résultat indépendant de l'ordre) ; T1 #3 / T2 #6 écart avec une période
// déclarée détecté structurellement (périodes chevauchantes, événements saisis après la déclaration, y compris contre-passations) ; T2 #4 relances :
// aucun palier consommé sans reste dû, reste dû relu après réclamation.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { recordPayment, reversePayment, runInvoiceReminders } from "@/lib/billing/invoices/invoice.service"
import { autoReconcile, importBankStatement } from "@/lib/accounting/c5/bank.service"
import { createSupplierInvoice, validateSupplierInvoice } from "@/lib/accounting/c5/supplier-invoice.service"
import { computeVat } from "@/lib/accounting/c5/vat"
import { declareVat } from "@/lib/accounting/c5/vat-declaration"
import { A, AFTER_PERIODS, D, NOW, js, seedCompanies, useTestClock, withClock } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const fr = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`
const M = { date: 0, label: 1, amount: 2, reference: 3, headerRows: 1 }, H = "Date;Libellé;Montant;Référence\n"
const supplier = async (number: string, ttc: number, day: string) => { const c = await createSupplierInvoice(db, A, { supplierName: "Fournisseur R13", siret: null, number, date: D(day), dueDate: null, totalHTCents: BigInt(ttc) * BigInt(5) / BigInt(6), vatCents: BigInt(ttc) - BigInt(ttc) * BigInt(5) / BigInt(6), totalTTCCents: BigInt(ttc), vatRateBp: 2000, category: "services", expenseAccountId: null, notes: null }, { fileId: null, ocr: null }); if (!c.ok) throw new Error(c.error); const v = await validateSupplierInvoice(db, A, c.value.id); if (!v.ok) throw new Error(v.error); return c.value.id }

before(async () => { useTestClock(); process.env.BILLING_COMPLETE_ENABLED = "true"; process.env.ACCOUNTING_MODULE_ENABLED = "true"; setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db); await db.$transaction((tx) => ensureBaseReferential(tx, A)); await db.$transaction((tx) => openFiscalYear(tx, A, { startDate: D("2026-01-01"), endDate: D("2026-12-31") })) })
after(async () => { setBillingMailerForTests(null); delete process.env.BILLING_COMPLETE_ENABLED; delete process.env.ACCOUNTING_MODULE_ENABLED; await db.$disconnect() })

describe("T2 #1/#2 — rapprochement automatique : montant seul insuffisant pour un fournisseur ; pièce convoitée par deux opérations ⇒ aucune", () => {
  it("fournisseur : un débit du bon montant sans référence ni date proche n'est pas rapproché ; avec la référence il l'est", async () => {
    const sup = await supplier("LOYER-JAN", 12000, "2026-01-05")
    const r1 = await importBankStatement(db, A, `${H}20/03/2026;PRLV DIVERS;-120,00;\n`, "s1.csv", M); assert.ok(r1.ok)
    const a1 = await autoReconcile(db, A); assert.equal(a1.matched, 0, js(a1))
    assert.equal((await db.supplierInvoice.findUniqueOrThrow({ where: { id: sup } })).paidAt, null)
    const r2 = await importBankStatement(db, A, `${H}21/03/2026;PRLV LOYER-JAN;-120,00;\n`, "s2.csv", M); assert.ok(r2.ok)
    const a2 = await autoReconcile(db, A); assert.equal(a2.matched, 1, js(a2))
    assert.ok((await db.supplierInvoice.findUniqueOrThrow({ where: { id: sup } })).paidAt)
  })
  it("client : deux crédits du même montant visant la même facture (date pour l'un, référence pour l'autre) ⇒ aucun rapprochement automatique, les deux restent à résoudre manuellement", async () => {
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "200", vatRate: "20" }], { now: new Date("2026-03-05T10:00:00Z") })
    const { number: num, dueDate } = await db.invoice.findUniqueOrThrow({ where: { id: inv } })
    // Pièce émise immuable : l'échéance par défaut (émission + 30 j) sert de date de rapprochement (tolérance ± 10 j).
    const dd = fr(dueDate!)
    const r = await importBankStatement(db, A, `${H}${dd};VIR DUPONT;240,00;\n${dd};VIR ${num};240,00;\n`, "c1.csv", M); assert.ok(r.ok)
    const a = await autoReconcile(db, A); assert.equal(a.matched, 0, js(a))
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: inv } }), 0)
    assert.equal(await db.bankTransaction.count({ where: { companyId: A.companyId, amountCents: BigInt(24000), status: "PENDING" } }), 2, "les deux opérations restent en attente")
  })
})

describe("T1 #3 / T2 #6 — période déclarée : événements tardifs détectés structurellement (périodes chevauchantes, contre-passations)", () => {
  it("trimestre déclaré ; paiement antidaté puis contre-passation saisis ensuite ⇒ avertissement structurel sur l'aperçu MENSUEL de février (période différente, aucun écart de totaux comparable) et sur le trimestre ; déclaration figée inchangée", async () => {
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }], { now: new Date("2026-02-02T10:00:00Z") })
    const p0 = await recordPayment(db, A, inv, { amountCents: BigInt(6000), method: "TRANSFER", paidAt: D("2026-02-05"), reference: null, notes: null }, new Date("2026-02-05T12:00:00Z")); assert.ok(p0.ok)
    const Q1 = [D("2026-01-01"), D("2026-03-31")] as const
    const d = await withClock(AFTER_PERIODS, () => declareVat(db, A, Q1[0], Q1[1], "ENCAISSEMENTS")); assert.ok(d.ok, js(d)); if (!d.ok) return
    const stored = await db.vatDeclaration.findUniqueOrThrow({ where: { id: d.value.id } })
    // Saisies tardives : paiement antidaté au 10/02 puis sa contre-passation ⇒ totaux du trimestre inchangés, mais événements postérieurs à la déclaration.
    const p = await recordPayment(db, A, inv, { amountCents: BigInt(3000), method: "TRANSFER", paidAt: D("2026-02-10"), reference: null, notes: null }, AFTER_PERIODS); assert.ok(p.ok); if (!p.ok) return
    const later = new Date(AFTER_PERIODS.getTime() + 86_400_000)
    useTestClock(later); const rev = await reversePayment(db, A, p.value.paymentId, "erreur", later); assert.ok(rev.ok, js(rev)); useTestClock()
    const feb = await computeVat(db, A, D("2026-02-01"), D("2026-02-28"), "ENCAISSEMENTS")
    assert.ok(feb.warnings.some((w) => /Période déjà déclarée \(2026-01-01 → 2026-03-31.*2 événement\(s\) saisi\(s\) après la déclaration.*paiements 1, contre-passations 1/.test(w)), js(feb.warnings))
    const q = await computeVat(db, A, Q1[0], Q1[1], "ENCAISSEMENTS")
    // Le paiement antidaté compte dans T1 ; sa contre-passation est datée du jour où elle est saisie (octobre) : T1 recalculé diffère (15 € vs 10 €).
    assert.equal(q.collectedCents, stored.collectedCents + BigInt(500))
    assert.ok(q.warnings.some((w) => /saisi\(s\) après la déclaration.*paiements 1, contre-passations 1/.test(w)), js(q.warnings))
    assert.ok(q.warnings.some((w) => /diffère de la déclaration figée/.test(w)), js(q.warnings))
    assert.equal((await db.vatDeclaration.findUniqueOrThrow({ where: { id: d.value.id } })).collectedCents, stored.collectedCents)
  })
})

describe("T2 #4 — relances de factures", () => {
  it("facture due : palier consommé et courrier (cadence inchangée) ; paiement committé entre réclamation du palier et relecture : palier RENDU, aucun courrier ; un reste dû nul avec statut SENT est impossible en base (PAYMENT_STATUS_MISMATCH) — le garde avant réclamation est défensif", async () => {
    // Échéance par défaut = émission + 30 j (2026-02-04) ; paliers 30/45/60 j dus au 10/04.
    const mk = async () => { const id = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }], { now: new Date("2026-01-05T10:00:00Z") }); assert.equal((await db.invoice.findUniqueOrThrow({ where: { id } })).dueDate?.toISOString(), "2026-02-04T00:00:00.000Z"); return id }
    const t60 = new Date("2026-04-10T10:00:00Z")
    // 0. Invariant de base : un paiement intégral enregistré hors service (statut SENT non reflété) est REFUSÉ ⇒ SENT/PARTIAL ⇒ reste dû > 0.
    const inv0 = await mk()
    await assert.rejects(db.invoicePayment.create({ data: { companyId: A.companyId, invoiceId: inv0, amountCents: BigInt(12000), method: "TRANSFER", paidAt: D("2026-01-25"), recordedById: A.userId } }), /PAYMENT_STATUS_MISMATCH/)
    // 1. Facture due : palier consommé et courrier envoyé.
    const r1 = await runInvoiceReminders(db, t60)
    assert.ok(r1.reminders.find((x) => x.step === 30)!.sent >= 1)
    assert.ok((await db.invoice.findUniqueOrThrow({ where: { id: inv0 } })).reminderDue30SentAt); assert.ok(await db.billingMailLog.count({ where: { documentId: inv0 } }) >= 1)
    // 2. Course : un paiement intégral (service, statut PAID) est committé juste APRÈS la réclamation du palier (crochet sur la mise à jour)
    //    ⇒ relecture ⇒ palier rendu, aucun courrier.
    const inv3 = await mk()
    const hooked = db.$extends({ query: { invoice: { async updateMany({ args, query }) { const r = await query(args); const data = args.data as Record<string, unknown>; if (data.reminderDue30SentAt instanceof Date) { const p = await recordPayment(db, A, inv3, { amountCents: BigInt(12000), method: "TRANSFER", paidAt: D("2026-04-10"), reference: null, notes: null }, t60); if (!p.ok) throw new Error(p.error) } return r } } } }) as unknown as PrismaClient
    await runInvoiceReminders(hooked, t60)
    const row3 = await db.invoice.findUniqueOrThrow({ where: { id: inv3 } })
    assert.equal(row3.status, "PAID"); assert.equal(row3.reminderDue30SentAt, null, "palier rendu après relecture d'un reste dû nul"); assert.equal(await db.billingMailLog.count({ where: { documentId: inv3 } }), 0)
    void NOW
  })
})
