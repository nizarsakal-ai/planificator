// Niveau ACTION publique / HTTP (mandat P1-05 et P2-02) : les Server Actions réelles sont appelées avec session simulée
// (mock.module), base PostgreSQL réelle. Aucun companyId client ne déplace la portée ; les identifiants de B sont refusés sans mutation.
// Exécution : node --import tsx --experimental-test-module-mocks --test tests/billing/fix/pg/fix-actions.pg.test.ts
import assert from "node:assert/strict"
import { after, before, describe, it, mock } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { parseQuoteForm } from "@/lib/billing/quotes/quote-schemas"
import { createQuote, sendQuote } from "@/lib/billing/quotes/quote.service"
import { importBankStatement } from "@/lib/accounting/c5/bank.service"
import { A, B, D, NOW, seedCompanies, useTestClock } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
process.env.BILLING_COMPLETE_ENABLED = "true"
process.env.ACCOUNTING_MODULE_ENABLED = "true"
process.env.AUTH_SECRET = "secret-de-test-hmac-ip"
mock.module("@/lib/prisma", { namedExports: { prisma: db } })
mock.module("next/cache", { namedExports: { revalidatePath: () => {} } })
mock.module("next/headers", { namedExports: { headers: async () => ({ get: () => "203.0.113.7" }) } })
mock.module("@/lib/accounting/access/accounting-access", { namedExports: { requireAccountingAdmin: async () => ({ companyId: "coA", userId: "admA", role: "ADMIN" }), resolveAccountingAccessForRequest: async () => ({ ok: false, reason: "TEST" }) } })
mock.module("@/lib/billing/access", { namedExports: {
  requireBillingAdmin: async () => ({ companyId: "coA", userId: "admA", role: "ADMIN" }),
  billingAccessMessage: (r: string) => r, BillingAccessError: class extends Error { constructor(readonly reason: string) { super(reason) } },
} })

const ids: Record<string, string> = {}
before(async () => {
  useTestClock() // R3 : horloge de décision déterministe (= NOW)
  setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db)
  for (const ctx of [A, B]) { await db.$transaction((tx) => ensureBaseReferential(tx, ctx)); await db.$transaction((tx) => openFiscalYear(tx, ctx, { startDate: D("2026-01-01"), endDate: D("2026-12-31") })) }
  const p = parseQuoteForm({ worksiteId: "wA", issueDate: "2026-03-10", validUntil: "2026-12-31", lines: [{ designation: "T", quantity: "1", unitPrice: "100", vatRate: "20" }] }); if (!p.ok) throw new Error(p.error)
  const q = await createQuote(db, A, p.value); if (!q.ok) throw new Error(q.error); ids.quote = q.value.id
  const s = await sendQuote(db, A, ids.quote, NOW); if (!s.ok) throw new Error(s.error); ids.token = s.value.signatureUrl.split("/devis-signature/")[1]
  ids.invA = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
  ids.invB = await issuedInvoice(db, B, "wB", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
  for (const [k, ctx] of [["A", A], ["B", B]] as const) {
    const imp = await importBankStatement(db, ctx, `Date;Libellé;Montant;Référence\n12/03/2026;VIR ${k};120,00;R${k}\n`, `${k}.csv`, { date: 0, label: 1, amount: 2, reference: 3, headerRows: 1 }); if (!imp.ok) throw new Error(imp.error)
    ids[`tx${k}`] = (await db.bankTransaction.findFirstOrThrow({ where: { importId: imp.value.importId } })).id
  }
})
after(async () => { setBillingMailerForTests(null); await db.$disconnect() })

describe("P1-05 — action publique de signature", () => {
  it("un companyId (ou tout champ étranger) dans la charge utile est refusé par le schéma strict ; rejeu refusé ; refus après acceptation refusé", async () => {
    const { signQuoteAction, refuseQuotePublicAction } = await import("@/lib/actions/quote.actions")
    assert.deepEqual(await signQuoteAction(ids.token, { signerName: "Client", approved: true, companyId: "coB" }), { ok: false, error: "Indiquez votre nom et cochez la case d'approbation." })
    assert.deepEqual(await signQuoteAction(ids.token, { signerName: "Client", approved: false }), { ok: false, error: "Indiquez votre nom et cochez la case d'approbation." })
    assert.equal((await db.quote.findUniqueOrThrow({ where: { id: ids.quote } })).status, "SENT")
    assert.deepEqual(await signQuoteAction("x".repeat(43), { signerName: "Client", approved: true }), { ok: false, error: "Lien de signature invalide ou expiré." })
    assert.deepEqual(await signQuoteAction(ids.token, { signerName: "Client", approved: true }), { ok: true })
    const q = await db.quote.findUniqueOrThrow({ where: { id: ids.quote } })
    assert.equal(q.status, "ACCEPTED"); assert.equal(q.companyId, "coA"); assert.ok(q.signatureIpHash, "empreinte IP HMAC présente, jamais l'IP en clair"); assert.notEqual(q.signatureIpHash, "203.0.113.7")
    assert.deepEqual(await signQuoteAction(ids.token, { signerName: "Rejeu", approved: true }), { ok: false, error: "Ce devis n'est pas en attente de signature." })
    assert.deepEqual(await refuseQuotePublicAction(ids.token, { reason: "tard" }), { ok: false, error: "Ce devis n'est pas en attente de signature." })
    assert.equal(await db.historyLog.count({ where: { entityId: ids.quote, detail: { contains: "signé en ligne" } } }), 1)
    delete process.env.BILLING_COMPLETE_ENABLED
    assert.deepEqual(await signQuoteAction(ids.token, { signerName: "Client", approved: true }), { ok: false, error: "Fonctionnalité indisponible." })
    process.env.BILLING_COMPLETE_ENABLED = "true"
  })
})

describe("P2-02 — action de rapprochement avec des identifiants de B", () => {
  it("refus sans fuite ni mutation préalable ; lien interne accepté", async () => {
    const { matchTransactionAction } = await import("@/lib/actions/accounting-c5.actions")
    const snapshot = async () => JSON.stringify(await db.bankTransaction.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, matchedInvoiceId: true, matchedPaymentId: true } }))
    const before = await snapshot()
    assert.deepEqual(await matchTransactionAction({ transactionId: ids.txA, invoiceId: ids.invB }), { ok: false, error: "Facture introuvable." })
    assert.deepEqual(await matchTransactionAction({ transactionId: ids.txB, invoiceId: ids.invA }), { ok: false, error: "Opération bancaire introuvable." })
    assert.deepEqual(await matchTransactionAction({ transactionId: ids.txA, invoiceId: ids.invA, companyId: "coB" } as unknown), { ok: false, error: "Demande invalide." })
    assert.equal(await snapshot(), before)
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: ids.invB } }), 0)
    assert.deepEqual(await matchTransactionAction({ transactionId: ids.txA, invoiceId: ids.invA }), { ok: true, status: "MATCHED" })
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: ids.invA, bankTransactionId: ids.txA } }), 1)
  })
})
