// Campagne D (suite) — auto-post ON par injection : l'écriture BQ du paiement de rapprochement est générée après COMMIT via la garde A2
// simulée (aucune session réelle), idempotente ; auto-post OFF ⇒ rien ; le transport comptable reste le moteur A1.
// Exécution : node --import tsx --experimental-test-module-mocks --test tests/billing/fix/pg/flags-autopost.pg.test.ts
import assert from "node:assert/strict"
import { after, before, describe, it, mock } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { A, D, seedCompanies } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
mock.module("@/lib/accounting/access/accounting-access", { namedExports: { requireAccountingAdmin: async () => ({ companyId: "coA", userId: "admA", role: "ADMIN" }), resolveAccountingAccessForRequest: async () => ({ ok: true, context: { companyId: "coA", userId: "admA", role: "ADMIN" } }) } })

before(async () => {
  process.env.BILLING_COMPLETE_ENABLED = "true"; process.env.ACCOUNTING_MODULE_ENABLED = "true"; delete process.env.ACCOUNTING_AUTO_POSTING_ENABLED
  setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db)
  await db.$transaction((tx) => ensureBaseReferential(tx, A)); await db.$transaction((tx) => openFiscalYear(tx, A, { startDate: D("2026-01-01"), endDate: D("2026-12-31") }))
})
after(async () => { setBillingMailerForTests(null); for (const f of ["BILLING_COMPLETE_ENABLED", "ACCOUNTING_MODULE_ENABLED", "ACCOUNTING_AUTO_POSTING_ENABLED"]) delete process.env[f]; await db.$disconnect() })

describe("auto-post par injection", () => {
  it("OFF ⇒ aucune écriture ; ON ⇒ écriture BQ après COMMIT, une seule fois, paiement unique", async () => {
    const { importBankStatement, matchTransaction } = await import("@/lib/accounting/c5/bank.service")
    const inv = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
    const imp = await importBankStatement(db, A, "Date;Libellé;Montant;Référence\n12/03/2026;VIR 1;50,00;R1\n12/03/2026;VIR 2;70,00;R2\n", "f.csv", { date: 0, label: 1, amount: 2, reference: 3, headerRows: 1 }); assert.ok(imp.ok); if (!imp.ok) return
    const [t1, t2] = await db.bankTransaction.findMany({ where: { importId: imp.value.importId }, orderBy: { amountCents: "asc" } })
    assert.ok((await matchTransaction(db, A, t1.id, { invoiceId: inv })).ok)
    assert.equal(await db.journalEntry.count({ where: { companyId: "coA" } }), 0, "auto-post OFF")
    process.env.ACCOUNTING_AUTO_POSTING_ENABLED = "true"
    assert.ok((await matchTransaction(db, A, t2.id, { invoiceId: inv })).ok)
    const p2 = await db.invoicePayment.findFirstOrThrow({ where: { bankTransactionId: t2.id } })
    assert.equal(await db.accountingDocumentPosting.count({ where: { sourceType: "PAYMENT", sourceId: p2.id } }), 1, "auto-post ON : écriture BQ générée après COMMIT")
    assert.equal(await db.journalEntry.count({ where: { companyId: "coA", journal: { code: "BQ" } } }), 1)
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: inv } }), 2)
    assert.equal((await db.invoice.findUniqueOrThrow({ where: { id: inv } })).status, "PAID")
  })
})
