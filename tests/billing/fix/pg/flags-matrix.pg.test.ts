// Campagne D (mandat §4.D) — drapeaux, isolation, fournisseurs, après migrations correctives :
// tous drapeaux absents/OFF ; BILLING_COMPLETE seul ON ; module comptable seul ON ; deux modules ON (auto-post OFF ici ; ON dans
// flags-autopost.pg.test.ts par injection). Transport courrier/OCR : routage vérifié par injection, JAMAIS d'envoi ni d'API réelle.
// Rôles autorisés/refusés, société inactive, révocation, SUPER_ADMIN borné à sa société (A2, portée inchangée), sociétés A/B.
import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { PrismaClient } from "@prisma/client"
import { RecordingMailer, getBillingMailer, setBillingMailerForTests } from "@/lib/billing/mail/mailer"
import { getOcrProvider, setOcrProviderForTests } from "@/lib/accounting/c5/ocr-provider"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import { openFiscalYear } from "@/lib/accounting/engine/fiscal-years"
import { resolveBillingAccessCore } from "@/lib/billing/access"
import { resolveAccountingAccess, type AccountingAccessDeps } from "@/lib/accounting/access/accounting-access.core"
import { isAccountingModuleEnabled } from "@/lib/accounting/accounting-feature-flag"
import { isAccountingAutoPostingEnabled, isBillingCompleteEnabled, isBillingMailEnabled, isBillingOcrEnabled } from "@/lib/billing/billing-feature-flag"
import { BANK_ERRORS, importBankStatement, matchTransaction } from "@/lib/accounting/c5/bank.service"
import { postMissingDocuments } from "@/lib/accounting/c5/postings"
import { transitionInvoiceCore } from "@/lib/billing/invoice-lifecycle.core"
import { listInvoices } from "@/lib/billing/invoices/invoice-queries"
import { A, B, D, NOW, js, seedCompanies, sqlError, useTestClock } from "./helpers"
import { issuedInvoice } from "./fixtures"

const db = new PrismaClient()
const FLAGS = ["BILLING_COMPLETE_ENABLED", "ACCOUNTING_MODULE_ENABLED", "ACCOUNTING_AUTO_POSTING_ENABLED", "BILLING_MAIL_ENABLED", "BILLING_OCR_ENABLED", "BILLING_REMINDERS_ENABLED"] as const
function setFlags(on: Partial<Record<(typeof FLAGS)[number], string>>) { for (const f of FLAGS) { if (on[f] !== undefined) process.env[f] = on[f]; else delete process.env[f] } }
const ids: Record<string, string> = {}
let n = 0
async function line(ctx: typeof A, amount: string) { const r = await importBankStatement(db, ctx, `Date;Libellé;Montant;Référence\n12/03/2026;VIR ${++n};${amount};R${n}\n`, `f${n}.csv`, { date: 0, label: 1, amount: 2, reference: 3, headerRows: 1 }); if (!r.ok) throw new Error(r.error); return (await db.bankTransaction.findFirstOrThrow({ where: { importId: r.value.importId } })).id }
const entries = () => db.journalEntry.count({ where: { companyId: "coA" } })
const deps = (over: Partial<AccountingAccessDeps> = {}): AccountingAccessDeps => ({
  auth: async () => ({ user: { id: "admA", role: "ADMIN", companyId: "coA" } }), isModuleEnabled: () => isAccountingModuleEnabled(),
  findCompany: async (id) => (id === "coA" ? { id, active: true } : id === "coB" ? { id, active: true } : id === "coX" ? { id, active: false } : null),
  findUserHomeCompanyId: async (uid) => (uid === "admA" ? "coA" : uid === "saGalya" ? "coA" : null), ...over,
})

before(async () => {
  useTestClock() // R3 : horloge de décision déterministe (= NOW)
  setFlags({}); setBillingMailerForTests(new RecordingMailer()); await seedCompanies(db)
  for (const ctx of [A, B]) { await db.$transaction((tx) => ensureBaseReferential(tx, ctx)); await db.$transaction((tx) => openFiscalYear(tx, ctx, { startDate: D("2026-01-01"), endDate: D("2026-12-31") })) }
  ids.invA = await issuedInvoice(db, A, "wA", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
  ids.invB = await issuedInvoice(db, B, "wB", [{ designation: "P", quantity: "1", unitPrice: "100", vatRate: "20" }])
})
after(async () => { setFlags({}); setBillingMailerForTests(null); setOcrProviderForTests(null); await db.$disconnect() })

describe("Matrice des drapeaux après migrations", () => {
  it("tous absents/OFF : facturation complète et comptabilité refusées, aucune mutation financière ; transports simulés ; anciens parcours Lot B et données héritées compatibles", async () => {
    setFlags({})
    assert.deepEqual([isBillingCompleteEnabled(), isAccountingModuleEnabled(), isAccountingAutoPostingEnabled(), isBillingMailEnabled(), isBillingOcrEnabled()], [false, false, false, false, false])
    assert.deepEqual(resolveBillingAccessCore(isBillingCompleteEnabled(), { user: { id: "admA", role: "ADMIN", companyId: "coA" } }), { ok: false, reason: "MODULE_DISABLED" })
    assert.equal((await resolveAccountingAccess(deps())).ok, false)
    const t = await line(A, "120,00")
    assert.deepEqual(await matchTransaction(db, A, t, { invoiceId: ids.invA }), { ok: false, error: BANK_ERRORS.flagOff })
    assert.equal(await db.invoicePayment.count(), 0); assert.equal(await entries(), 0)
    setBillingMailerForTests(null); assert.equal(getBillingMailer().name, "recording"); setBillingMailerForTests(new RecordingMailer())
    await assert.rejects(getOcrProvider().extract({ data: Buffer.from("x"), mime: "image/png" }))
    // Ancien parcours Lot B (drapeau OFF) : émission d'un brouillon FAC-… par transitionInvoiceCore ⇒ SENT + snapshot documentaire ; PAID hérité sans paiement toléré.
    await db.$executeRawUnsafe(`INSERT INTO invoices(id,"companyId","worksiteId","clientId",number,"createdById","updatedAt",status,kind,"totalHT","totalVAT","totalTTC") VALUES ('lotb1','coA','wA','clA','FAC-2026-0900','admA',now(),'DRAFT','INVOICE',100,20,120)`)
    await db.$executeRawUnsafe(`INSERT INTO invoice_lines(id,"invoiceId",designation,quantity,"unitPrice","vatRate","lineHT") VALUES ('lotb1-l','lotb1','L',1,100,20,100)`)
    const r = await db.$transaction((tx) => transitionInvoiceCore(tx, { companyId: "coA", invoiceId: "lotb1", to: "SENT", actorId: "admA", now: NOW }))
    assert.ok(r.ok, js(r)); assert.equal(await db.invoiceDocumentSnapshot.count({ where: { invoiceId: "lotb1" } }), 1)
    const paid = await db.$transaction((tx) => transitionInvoiceCore(tx, { companyId: "coA", invoiceId: "lotb1", to: "PAID", actorId: "admA", now: NOW }))
    assert.ok(paid.ok, js(paid))
    assert.equal(await sqlError(db, `UPDATE invoices SET "updatedAt"=now() WHERE id='lotb1'`), "NO_ERROR", "PAID héritée sans paiement : contrôle différé satisfait")
    assert.match(await sqlError(db, `DELETE FROM invoices WHERE id='lotb1'`), /INVOICE_IMMUTABLE/)
  })
  it("BILLING_COMPLETE seul ON : rapprochement client autorisé (paiement créé), comptabilité refusée ⇒ aucune écriture automatique", async () => {
    setFlags({ BILLING_COMPLETE_ENABLED: "true" })
    const t = await line(A, "50,00")
    assert.ok((await matchTransaction(db, A, t, { invoiceId: ids.invA })).ok)
    assert.equal(await db.invoicePayment.count({ where: { invoiceId: ids.invA } }), 1); assert.equal(await entries(), 0)
    assert.equal((await resolveAccountingAccess(deps())).ok, false)
  })
  it("module comptable seul ON : rapprochement client refusé sans mutation ; génération manuelle des écritures possible ; A/B isolées", async () => {
    setFlags({ ACCOUNTING_MODULE_ENABLED: "true" })
    const t = await line(A, "10,00")
    assert.deepEqual(await matchTransaction(db, A, t, { invoiceId: ids.invA }), { ok: false, error: BANK_ERRORS.flagOff })
    assert.ok((await resolveAccountingAccess(deps())).ok)
    const r = await postMissingDocuments(db, A); assert.equal(r.errors.length, 0, js(r.errors)); assert.ok(r.posted >= 2)
    assert.equal(await db.journalEntry.count({ where: { companyId: "coB" } }), 0)
    assert.equal((await listInvoices(db, "coB", {})).rows.some((x) => x.id === ids.invA), false)
  })
  it("deux modules ON, auto-post OFF : paiement par rapprochement sans écriture automatique ; la génération manuelle rattrape une seule fois", async () => {
    setFlags({ BILLING_COMPLETE_ENABLED: "true", ACCOUNTING_MODULE_ENABLED: "true" })
    const before = await entries()
    const t = await line(A, "20,00")
    assert.ok((await matchTransaction(db, A, t, { invoiceId: ids.invA })).ok)
    assert.equal(await entries(), before, "auto-post OFF : aucune écriture automatique")
    const r = await postMissingDocuments(db, A); assert.equal(r.posted, 1); assert.equal((await postMissingDocuments(db, A)).posted, 0)
  })
  it("transports : BILLING_MAIL_ENABLED=true route vers Resend (instance créée, aucun envoi) ; BILLING_OCR_ENABLED=true + clé factice ⇒ fournisseur désactivé en contexte de test (refus, aucun appel)", async () => {
    setFlags({ BILLING_MAIL_ENABLED: "true", BILLING_OCR_ENABLED: "true" }); process.env.ANTHROPIC_API_KEY = "sk-ant-factice"
    setBillingMailerForTests(null); assert.equal(getBillingMailer().name, "resend"); setBillingMailerForTests(new RecordingMailer())
    await assert.rejects(getOcrProvider().extract({ data: Buffer.from("x"), mime: "image/png" }), /désactiv|disabled|OCR/i)
    delete process.env.ANTHROPIC_API_KEY; setFlags({})
  })
  it("rôles : TEAM_LEADER refusé, sans société refusé, société inactive refusée, compte révoqué refusé, SUPER_ADMIN limité à sa société de rattachement (A2 inchangé)", async () => {
    setFlags({ BILLING_COMPLETE_ENABLED: "true", ACCOUNTING_MODULE_ENABLED: "true" })
    assert.deepEqual(resolveBillingAccessCore(true, { user: { id: "u", role: "TEAM_LEADER", companyId: "coA" } }), { ok: false, reason: "FORBIDDEN" })
    assert.deepEqual(resolveBillingAccessCore(true, { user: { id: "u", role: "ADMIN", companyId: null } }), { ok: false, reason: "NO_COMPANY" })
    assert.deepEqual(resolveBillingAccessCore(true, null), { ok: false, reason: "UNAUTHENTICATED" })
    assert.equal((await resolveAccountingAccess(deps({ auth: async () => ({ user: { id: "admA", role: "ADMIN", companyId: "coX" } }) }))).ok, false, "société inactive")
    // Révocation : la garde A2 borne le SUPER_ADMIN par sa société de rattachement en base ; pour un ADMIN, la révocation relève de la
    // session (JWT relu en base côté Node) — portée A2 inchangée par ce lot (mandat : ne pas étendre SUPER_ADMIN).
    assert.equal((await resolveAccountingAccess(deps({ auth: async () => ({ user: { id: "ghost", role: "SUPER_ADMIN", companyId: "coA" } }) }))).ok, false, "SUPER_ADMIN sans rattachement en base ⇒ refusé")
    assert.deepEqual(await resolveAccountingAccess(deps({ auth: async () => ({ user: { id: "saGalya", role: "SUPER_ADMIN", companyId: "coA" } }) })), { ok: true, context: { userId: "saGalya", role: "SUPER_ADMIN", companyId: "coA" } })
    assert.equal((await resolveAccountingAccess(deps({ auth: async () => ({ user: { id: "saGalya", role: "SUPER_ADMIN", companyId: "coB" } }) }))).ok, false, "SUPER_ADMIN : jamais une autre société")
  })
})
