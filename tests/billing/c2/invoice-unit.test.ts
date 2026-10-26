// Lot C2 — tests unitaires purs : schémas facture/paiement, contrôles d'émission, statut selon paiements, automate (transaction simulée), OVERDUE calculé.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Prisma } from "@prisma/client"
import { setBillingClockForTests } from "@/lib/billing/clock"
import { parseInvoiceForm, parsePaymentForm } from "@/lib/billing/invoices/invoice-schemas"
import { INVOICE_C2_ERRORS, LEGAL_NUMBER, issueBlockers, issueInvoiceCore, recordPaymentCore, replaceInvoiceDraftCore, reversePaymentCore, statusForPaid } from "@/lib/billing/invoices/invoice-c2.core"
import { invoiceWhere, isOverdue, todayUtc } from "@/lib/billing/invoices/invoice-queries"
import { invoiceFiltersFromParams } from "@/lib/billing/invoices/invoice-filters"

const c = (n: number) => BigInt(n)
const now = new Date("2026-03-10T10:00:00Z")
setBillingClockForTests(() => now) // R3/S3 : horloge de décision déterministe (= now) pour les horodatages et dates d'émission

describe("schémas", () => {
  it("facture : lignes converties, TTC négatif refusé, champ inconnu refusé", () => {
    const ok = parseInvoiceForm({ worksiteId: "w", lines: [{ designation: "A", quantity: "2", unitPrice: "10", vatRate: "20" }], dueDate: "2026-04-10" })
    assert.ok(ok.ok); if (!ok.ok) return
    assert.equal(ok.value.totals.totalTTCCents, c(2400)); assert.equal(ok.value.dueDate?.toISOString(), "2026-04-10T00:00:00.000Z"); assert.equal(ok.value.quoteId, null)
    assert.equal(parseInvoiceForm({ worksiteId: "w", companyId: "x", lines: [{ designation: "A", quantity: "1", unitPrice: "1", vatRate: "20" }] }).ok, false)
    assert.equal(parseInvoiceForm({ worksiteId: "w", lines: [] }).ok, false)
  })
  it("paiement : montant > 0, méthode connue, date calendaire", () => {
    const p = parsePaymentForm({ amount: "12,50", method: "CHECK", paidAt: "2026-03-10", reference: "123" })
    assert.ok(p.ok); if (!p.ok) return
    assert.equal(p.value.amountCents, c(1250)); assert.equal(p.value.reference, "123"); assert.equal(p.value.notes, null)
    assert.equal(parsePaymentForm({ amount: "0", method: "CASH", paidAt: "2026-03-10" }).ok, false)
    assert.equal(parsePaymentForm({ amount: "-5", method: "CASH", paidAt: "2026-03-10" }).ok, false)
    assert.equal(parsePaymentForm({ amount: "5", method: "BITCOIN", paidAt: "2026-03-10" }).ok, false)
    assert.equal(parsePaymentForm({ amount: "5", method: "CASH", paidAt: "2026-02-30" }).ok, false)
  })
})

describe("règles pures", () => {
  it("contrôles d'émission : vendeur (nom, adresse, SIRET 14 chiffres), client, lignes", () => {
    assert.deepEqual(issueBlockers({ company: { name: "S", address: "1 rue", siret: "123 456 789 00012" }, client: { name: "C", address: "2 rue" }, lineCount: 1 }), [])
    const b = issueBlockers({ company: { name: " ", address: null, siret: "123" }, client: { name: "", address: null }, lineCount: 0 })
    assert.deepEqual(b.map((x) => x.code), ["SELLER_NAME", "SELLER_ADDRESS", "SELLER_SIRET", "CLIENT_NAME", "CLIENT_ADDRESS", "NO_LINES"])
  })
  it("statut selon la somme des paiements ; numéro légal", () => {
    assert.equal(statusForPaid(c(0), c(100)), "SENT"); assert.equal(statusForPaid(c(1), c(100)), "PARTIAL"); assert.equal(statusForPaid(c(100), c(100)), "PAID"); assert.equal(statusForPaid(c(-5), c(100)), "SENT")
    // C4 : avoirs partiels comptés dans le solde ; sans paiement, jamais PAID par cette fonction (le service le gère).
    assert.equal(statusForPaid(c(60), c(100), c(40)), "PAID"); assert.equal(statusForPaid(c(10), c(100), c(40)), "PARTIAL"); assert.equal(statusForPaid(c(0), c(100), c(100)), "SENT")
    assert.ok(LEGAL_NUMBER.test("FAC-2026-0001")); assert.ok(!LEGAL_NUMBER.test("PROV-2026-0001"))
  })
  it("OVERDUE calculé : SENT/PARTIAL avec échéance passée, jamais pour un avoir, un brouillon ou une facture payée", () => {
    const today = todayUtc(now)
    assert.equal(isOverdue({ status: "SENT", dueDate: new Date("2026-03-09T00:00:00Z"), kind: "INVOICE" }, today), true)
    assert.equal(isOverdue({ status: "PARTIAL", dueDate: new Date("2026-03-09T00:00:00Z"), kind: "INVOICE" }, today), true)
    assert.equal(isOverdue({ status: "SENT", dueDate: new Date("2026-03-10T00:00:00Z"), kind: "INVOICE" }, today), false)
    assert.equal(isOverdue({ status: "PAID", dueDate: new Date("2026-03-01T00:00:00Z"), kind: "INVOICE" }, today), false)
    assert.equal(isOverdue({ status: "SENT", dueDate: new Date("2026-03-01T00:00:00Z"), kind: "CREDIT_NOTE" }, today), false)
    assert.equal(isOverdue({ status: "DRAFT", dueDate: null, kind: "INVOICE" }, today), false)
    const w = invoiceWhere("co", { overdue: true, status: "PAID" }, today)
    assert.deepEqual(w.status, { in: ["SENT", "PARTIAL"] }); assert.equal(w.companyId, "co")
    const f = invoiceFiltersFromParams({ q: "x", retard: "1", du: "2026-02-30", page: "2" })
    assert.equal(f.overdue, true); assert.equal(f.from, undefined); assert.equal(f.page, 2)
  })
})

// Transaction simulée appliquant les `where` (statut, société) comme PostgreSQL.
type Row = Record<string, unknown> & { id: string }
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && "in" in (v as object)) return ((v as { in: unknown[] }).in).includes(row[k])
    return row[k] === v
  })
}
function makeTx(invoices: Row[], payments: Row[] = []) {
  const inv = invoices.map((r) => ({ ...r })); const pay = payments.map((r) => ({ ...r })); const lines: Row[] = []; const history: Row[] = []
  let seq = 0; const hooks: { beforeUpdate?: () => void } = {}
  const tx = {
    $queryRaw: async () => [], // verrous partagés client/société (no-op sans base)
    invoice: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => { const r = inv.find((x) => matches(x, where)); return r ? { ...r, company: { name: "S", address: "1 rue", siret: "12345678900012" }, client: { name: "C", address: "2 rue" }, lines: (r.lines as unknown[]) ?? [] } : null },
      // Avoirs partiels (C4) : aucun dans ces scénarios.
      findMany: async () => [],
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { hooks.beforeUpdate?.(); let n = 0; for (const r of inv) if (matches(r, where)) { Object.assign(r, data); n++ } return { count: n } },
    },
    invoiceLine: { deleteMany: async () => ({ count: 0 }), createMany: async ({ data }: { data: Row[] }) => { lines.push(...data); return { count: data.length } } },
    invoicePayment: {
      aggregate: async ({ where }: { where: Record<string, unknown> }) => ({ _sum: { amountCents: pay.filter((p) => matches(p, where)).reduce((s, p) => s + (p.amountCents as bigint), c(0)) } }),
      create: async ({ data }: { data: Record<string, unknown> }) => { const id = `p${++seq}`; pay.push({ id, reversedAt: null, reversesPaymentId: null, ...data }); return { id } },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => pay.find((p) => matches(p, where)) ?? null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { let n = 0; for (const p of pay) if (matches(p, where)) { Object.assign(p, data); n++ } return { count: n } },
    },
    historyLog: { create: async ({ data }: { data: Record<string, unknown> }) => { history.push({ id: `h${++seq}`, ...data }); return data } },
  } as unknown as Prisma.TransactionClient
  return { tx, inv, pay, history, hooks }
}
const A = "coA", B = "coB"
const line = { quantity: new Prisma.Decimal("1.00"), unitPrice: new Prisma.Decimal("100.00"), vatRate: new Prisma.Decimal("20.00"), discountBp: 0 }
const invoice = (id: string, status: string, over: Record<string, unknown> = {}): Row => ({ id, companyId: A, status, kind: "INVOICE", number: `PROV-2026-000${id}`, dueDate: null, worksiteId: "w", globalDiscountBp: 0, vatReverseCharge: false, totalTTC: new Prisma.Decimal("120.00"), lines: [line], ...over })
const noLock = async () => {}
const issueInput = { companyId: A, actorId: "u", now, paymentTermsDays: 30, nextLegalNumber: async (_t: unknown, y: number) => `FAC-${y}-0007`, lockInvoice: noLock, captureSnapshot: async () => {} }

describe("émission", () => {
  it("DRAFT → SENT : numéro légal, date d'émission = jour, échéance = +30 j, totaux recalculés depuis les lignes", async () => {
    const { tx, inv, history } = makeTx([invoice("1", "DRAFT", { totalTTC: new Prisma.Decimal("1.00") })])
    const r = await issueInvoiceCore(tx, { ...issueInput, invoiceId: "1" })
    assert.deepEqual(r, { ok: true, value: { number: "FAC-2026-0007", issueDate: new Date("2026-03-10T00:00:00.000Z"), dueDate: new Date("2026-04-09T00:00:00.000Z") } })
    assert.equal(inv[0].status, "SENT"); assert.equal(inv[0].number, "FAC-2026-0007"); assert.equal(inv[0].totalTTC, "120.00"); assert.equal(inv[0].totalVAT, "20.00"); assert.equal((inv[0].sentAt as Date).toISOString(), now.toISOString())
    assert.equal(history[0].action, "STATUS_CHANGED")
  })
  it("brouillon déjà numéroté FAC (chemin Lot B) : numéro conservé si même année, renuméroté sinon ; échéance future conservée", async () => {
    const { tx, inv } = makeTx([invoice("1", "DRAFT", { number: "FAC-2026-0003", dueDate: new Date("2026-05-01T00:00:00Z") })])
    const r = await issueInvoiceCore(tx, { ...issueInput, invoiceId: "1" })
    assert.ok(r.ok); assert.equal(inv[0].number, "FAC-2026-0003"); assert.equal((inv[0].dueDate as Date).toISOString(), "2026-05-01T00:00:00.000Z")
    const s2 = makeTx([invoice("2", "DRAFT", { number: "FAC-2025-0009" })])
    assert.ok((await issueInvoiceCore(s2.tx, { ...issueInput, invoiceId: "2" })).ok); assert.equal(s2.inv[0].number, "FAC-2026-0007")
  })
  it("date de paiement future refusée", async () => {
    const s = makeTx([invoice("1", "SENT")])
    const r = await recordPaymentCore(s.tx, { companyId: A, actorId: "u", now, invoiceId: "1", amountCents: c(1), method: "CASH", paidAt: new Date("2026-04-01T00:00:00Z"), reference: null, notes: null, lockInvoice: noLock, enablePaymentsContext: noLock })
    assert.equal(r.ok, false)
  })
  it("refus : non brouillon, avoir, sans ligne, mentions vendeur manquantes, autre société, course", async () => {
    assert.deepEqual(await issueInvoiceCore(makeTx([invoice("1", "SENT")]).tx, { ...issueInput, invoiceId: "1" }), { ok: false, error: INVOICE_C2_ERRORS.notDraft })
    assert.deepEqual(await issueInvoiceCore(makeTx([invoice("1", "DRAFT", { kind: "CREDIT_NOTE" })]).tx, { ...issueInput, invoiceId: "1" }), { ok: false, error: INVOICE_C2_ERRORS.notInvoice })
    assert.match((await issueInvoiceCore(makeTx([invoice("1", "DRAFT", { lines: [] })]).tx, { ...issueInput, invoiceId: "1" }) as { error: string }).error, /au moins une ligne/)
    assert.deepEqual(await issueInvoiceCore(makeTx([invoice("1", "DRAFT")]).tx, { ...issueInput, companyId: B, invoiceId: "1" }), { ok: false, error: INVOICE_C2_ERRORS.notFound })
    const s = makeTx([invoice("1", "DRAFT")])
    s.hooks.beforeUpdate = () => { s.inv[0].status = "SENT"; s.hooks.beforeUpdate = undefined }
    // Numéro légal déjà consommé ⇒ exception (ROLLBACK), jamais un simple retour.
    await assert.rejects(issueInvoiceCore(s.tx, { ...issueInput, invoiceId: "1" }), /INVOICE_CONFLICT/)
  })
})

describe("paiements", () => {
  const pay = (amount: number) => ({ companyId: A, actorId: "u", now, amountCents: c(amount), method: "TRANSFER" as const, paidAt: now, reference: null, notes: null, lockInvoice: noLock, enablePaymentsContext: noLock })
  it("partiel ⇒ PARTIAL ; solde exact ⇒ PAID + paidAt ; dépassement refusé (plafond relu) ; PAID ⇒ déjà soldée", async () => {
    const s = makeTx([invoice("1", "SENT")])
    const r1 = await recordPaymentCore(s.tx, { ...pay(5000), invoiceId: "1" })
    assert.ok(r1.ok); if (!r1.ok) return
    assert.equal(r1.value.status, "PARTIAL"); assert.equal(r1.value.remainingCents, c(7000)); assert.equal(s.inv[0].status, "PARTIAL")
    assert.deepEqual(await recordPaymentCore(s.tx, { ...pay(7001), invoiceId: "1" }), { ok: false, error: `${INVOICE_C2_ERRORS.exceeds} (reste : 70.00 €)` })
    const r2 = await recordPaymentCore(s.tx, { ...pay(7000), invoiceId: "1" })
    assert.ok(r2.ok && r2.value.status === "PAID"); assert.equal(s.inv[0].status, "PAID"); assert.equal(s.inv[0].paidAt, now)
    assert.deepEqual(await recordPaymentCore(s.tx, { ...pay(1), invoiceId: "1" }), { ok: false, error: INVOICE_C2_ERRORS.alreadyPaid })
    assert.equal(s.pay.length, 2); assert.equal(s.history.length, 2)
  })
  it("refus : brouillon, annulée, avoir, autre société, montant nul", async () => {
    assert.deepEqual(await recordPaymentCore(makeTx([invoice("1", "DRAFT")]).tx, { ...pay(1), invoiceId: "1" }), { ok: false, error: INVOICE_C2_ERRORS.notPayable })
    assert.deepEqual(await recordPaymentCore(makeTx([invoice("1", "CANCELLED")]).tx, { ...pay(1), invoiceId: "1" }), { ok: false, error: INVOICE_C2_ERRORS.notPayable })
    assert.deepEqual(await recordPaymentCore(makeTx([invoice("1", "SENT", { kind: "CREDIT_NOTE" })]).tx, { ...pay(1), invoiceId: "1" }), { ok: false, error: INVOICE_C2_ERRORS.notPayable })
    assert.deepEqual(await recordPaymentCore(makeTx([invoice("1", "SENT")]).tx, { ...pay(1), companyId: B, invoiceId: "1" }), { ok: false, error: INVOICE_C2_ERRORS.notFound })
    assert.equal((await recordPaymentCore(makeTx([invoice("1", "SENT")]).tx, { ...pay(0), invoiceId: "1" })).ok, false)
  })
  it("contre-passation : ligne opposée, statut recalculé, paidAt effacé ; double annulation et annulation d'une annulation refusées", async () => {
    const s = makeTx([invoice("1", "SENT")])
    const r1 = await recordPaymentCore(s.tx, { ...pay(12000), invoiceId: "1" })
    assert.ok(r1.ok); if (!r1.ok) return
    assert.equal(s.inv[0].status, "PAID")
    const rev = { companyId: A, actorId: "u", now, reason: "erreur", lockInvoice: noLock, enablePaymentsContext: noLock }
    const r2 = await reversePaymentCore(s.tx, { ...rev, paymentId: r1.value.paymentId })
    assert.deepEqual(r2, { ok: true, value: { status: "SENT" } })
    assert.equal(s.inv[0].status, "SENT"); assert.equal(s.inv[0].paidAt, null); assert.equal(s.pay.length, 2); assert.equal(s.pay[1].amountCents, c(-12000)); assert.equal(s.pay[1].reversesPaymentId, r1.value.paymentId); assert.ok(s.pay[0].reversedAt)
    assert.deepEqual(await reversePaymentCore(s.tx, { ...rev, paymentId: r1.value.paymentId }), { ok: false, error: INVOICE_C2_ERRORS.alreadyReversed })
    assert.deepEqual(await reversePaymentCore(s.tx, { ...rev, paymentId: s.pay[1].id }), { ok: false, error: INVOICE_C2_ERRORS.isReversal })
    assert.deepEqual(await reversePaymentCore(s.tx, { ...rev, companyId: B, paymentId: r1.value.paymentId }), { ok: false, error: INVOICE_C2_ERRORS.paymentNotFound })
  })
  it("remplacement d'un brouillon : refusé hors DRAFT et pour un avoir", async () => {
    const header = { dueDate: null, subject: null, notes: null, paymentTerms: null, globalDiscountBp: 0, vatReverseCharge: false, totalHT: "1.00", totalVAT: "0.20", totalTTC: "1.20" }
    assert.equal((await replaceInvoiceDraftCore(makeTx([invoice("1", "DRAFT")]).tx, { companyId: A, invoiceId: "1", actorId: "u", header, lines: [] })).ok, true)
    assert.deepEqual(await replaceInvoiceDraftCore(makeTx([invoice("1", "SENT")]).tx, { companyId: A, invoiceId: "1", actorId: "u", header, lines: [] }), { ok: false, error: INVOICE_C2_ERRORS.notDraft })
    assert.deepEqual(await replaceInvoiceDraftCore(makeTx([invoice("1", "DRAFT", { kind: "CREDIT_NOTE" })]).tx, { companyId: A, invoiceId: "1", actorId: "u", header, lines: [] }), { ok: false, error: INVOICE_C2_ERRORS.notDraft })
  })
})
