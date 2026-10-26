// ═══════════════════════════════════════════════════════════════════════════
// Écritures comptables depuis les pièces de facturation (SPEC-BILLING-C5 §3.1). Jamais d'écriture hors moteur A1 :
// createDraftEntry (idempotente par source) + postEntry, sous runAccountingTransaction, contexte requireAccountingAdmin.
// Comptes du référentiel A1 par numéro ; exercice = celui contenant la date de la pièce.
// ═══════════════════════════════════════════════════════════════════════════
import type { Prisma, PrismaClient } from "@prisma/client"
import { AccountingError, createDraftEntry, postEntry, type AccountingContext } from "@/lib/accounting/engine/posting"
import { ensureBaseReferential } from "@/lib/accounting/engine/setup"
import type { LineInput } from "@/lib/accounting/engine/validate"
import { runAccountingTransaction } from "@/lib/accounting/engine/transaction"
import { computeDocumentTotals, decimalToCents, storedVatRateToBp } from "@/lib/billing/money"
import { DocumentIntegrityError, assertStoredTotalsMatch } from "@/lib/billing/document-integrity"

type Tx = Prisma.TransactionClient
export type PostingSourceType = "INVOICE" | "CREDIT_NOTE" | "DEPOSIT" | "PAYMENT" | "SUPPLIER_INVOICE"

export const ACCOUNTS = { clients: "411000", sales: "706000", vatCollected: "445710", bank: "512000", cash: "530000", suppliers: "401000", vatDeductible: "445660", defaultExpense: "606000" } as const

export class PostingError extends Error {
  constructor(readonly code: string, message?: string) { super(message ?? code); this.name = "PostingError" }
}

async function accountId(tx: Tx, ctx: AccountingContext, number: string): Promise<string> {
  const a = await tx.accountingAccount.findFirst({ where: { companyId: ctx.companyId, number, active: true }, select: { id: true } })
  if (!a) throw new PostingError("ACCOUNT_MISSING", `Compte ${number} absent ou inactif dans le plan comptable de la société.`)
  return a.id
}
async function journalId(tx: Tx, ctx: AccountingContext, code: "VT" | "HA" | "BQ"): Promise<string> {
  const j = await tx.accountingJournal.findFirst({ where: { companyId: ctx.companyId, code }, select: { id: true } })
  if (!j) throw new PostingError("JOURNAL_MISSING", `Journal ${code} absent.`)
  return j.id
}
async function fiscalYearFor(tx: Tx, ctx: AccountingContext, date: Date): Promise<string> {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const fy = await tx.fiscalYear.findFirst({ where: { companyId: ctx.companyId, startDate: { lte: day }, endDate: { gte: day } }, select: { id: true, status: true } })
  if (!fy) throw new PostingError("NO_FISCAL_YEAR", `Aucun exercice ne couvre la date ${day.toISOString().slice(0, 10)} : ouvrez-le dans Comptabilité › Exercices.`)
  if (fy.status !== "OPEN") throw new PostingError("FISCAL_YEAR_CLOSED", "L'exercice de la pièce n'est plus ouvert.")
  return fy.id
}
const dayOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
/** Ligne débit/crédit : un montant négatif inverse le sens (les lignes stockent des montants positifs). */
function side(accountId: string, debit: bigint, credit: bigint, label: string | null, vatRateBp: number | null = null): LineInput | null {
  let d = debit, c = credit
  if (d < BigInt(0)) { c += -d; d = BigInt(0) }
  if (c < BigInt(0)) { d += -c; c = BigInt(0) }
  if (d === c) { if (d === BigInt(0)) return null; d -= c; c = BigInt(0) }
  if (d > BigInt(0) && c > BigInt(0)) { const n = d - c; d = n > BigInt(0) ? n : BigInt(0); c = n < BigInt(0) ? -n : BigInt(0) }
  if (d === BigInt(0) && c === BigInt(0)) return null
  return { accountId, debitCents: d, creditCents: c, label, vatRateBp }
}

/** Écriture d'une facture, d'un acompte ou d'un avoir émis (journal VT). */
export async function postInvoiceEntry(tx: Tx, ctx: AccountingContext, invoiceId: string): Promise<{ entryId: string; existing: boolean }> {
  const inv = await tx.invoice.findFirst({
    where: { id: invoiceId, companyId: ctx.companyId },
    select: { id: true, number: true, kind: true, status: true, sentAt: true, issueDate: true, totalHT: true, totalVAT: true, totalTTC: true, globalDiscountBp: true, vatReverseCharge: true, client: { select: { name: true } }, lines: { select: { quantity: true, unitPrice: true, vatRate: true, discountBp: true, deductsDepositId: true } } },
  })
  if (!inv) throw new PostingError("DOCUMENT_NOT_FOUND")
  if (inv.status === "DRAFT" || !inv.sentAt) throw new PostingError("DOCUMENT_NOT_ISSUED", "Pièce non émise.")
  const sourceType: PostingSourceType = inv.kind === "CREDIT_NOTE" ? "CREDIT_NOTE" : inv.kind === "DEPOSIT" ? "DEPOSIT" : "INVOICE"
  const existing = await tx.accountingDocumentPosting.findFirst({ where: { companyId: ctx.companyId, sourceType, sourceId: inv.id, sourceVersion: 1 }, select: { entryId: true } })
  if (existing) return { entryId: existing.entryId, existing: true }
  const totals = computeDocumentTotals(inv.lines.map((l) => ({ quantityHundredths: decimalToCents(l.quantity), unitPriceCents: decimalToCents(l.unitPrice), discountBp: l.discountBp, vatRateBp: storedVatRateToBp(l.vatRate), excludeGlobalDiscount: !!l.deductsDepositId })), { globalDiscountBp: inv.globalDiscountBp, vatReverseCharge: inv.vatReverseCharge })
  // Correctif P1-01 : totaux persistés = recalcul, sinon refus explicite AVANT toute écriture (jamais d'écriture d'un autre montant).
  try { assertStoredTotalsMatch(inv, totals) } catch (e) {
    if (e instanceof DocumentIntegrityError) throw new PostingError("TOTALS_MISMATCH", `Pièce ${inv.number} refusée : totaux enregistrés (${decimalToCents(inv.totalTTC)} c TTC) différents du recalcul des lignes (${totals.totalTTCCents} c TTC). Aucune écriture générée.`)
    throw e
  }
  const sign = inv.kind === "CREDIT_NOTE" ? BigInt(-1) : BigInt(1)
  const [a411, a706, a44571] = await Promise.all([accountId(tx, ctx, ACCOUNTS.clients), accountId(tx, ctx, ACCOUNTS.sales), accountId(tx, ctx, ACCOUNTS.vatCollected)])
  const label = `${inv.kind === "CREDIT_NOTE" ? "Avoir" : inv.kind === "DEPOSIT" ? "Acompte" : "Facture"} ${inv.number} — ${inv.client.name}`
  const lines: LineInput[] = []
  const l411 = side(a411, sign * totals.totalTTCCents, BigInt(0), label)
  if (l411) lines.push(l411)
  for (const v of totals.vatSummary) {
    const lHT = side(a706, BigInt(0), sign * v.baseCents, `${label} HT ${v.vatRateBp / 100} %`)
    if (lHT) lines.push(lHT)
    const lVat = side(a44571, BigInt(0), sign * v.vatCents, `${label} TVA ${v.vatRateBp / 100} %`, v.vatRateBp)
    if (lVat) lines.push(lVat)
  }
  if (lines.length < 2) throw new PostingError("DOCUMENT_EMPTY", "Pièce sans montant : aucune écriture.")
  const draft = await createDraftEntry(tx, ctx, { journalId: await journalId(tx, ctx, "VT"), fiscalYearId: await fiscalYearFor(tx, ctx, inv.issueDate), entryDate: dayOf(inv.issueDate), documentDate: dayOf(inv.issueDate), documentRef: inv.number, label, lines, source: { type: sourceType, id: inv.id, version: 1 } })
  await postEntry(tx, ctx, draft.id)
  await linkPosting(tx, ctx, sourceType, inv.id, draft.id)
  return { entryId: draft.id, existing: draft.existing }
}

/** Lien pièce ↔ écriture, idempotent (deux générations concurrentes : la seconde retrouve la même écriture). */
async function linkPosting(tx: Tx, ctx: AccountingContext, sourceType: PostingSourceType, sourceId: string, entryId: string): Promise<void> {
  await tx.accountingDocumentPosting.createMany({ data: [{ companyId: ctx.companyId, sourceType, sourceId, sourceVersion: 1, entryId }], skipDuplicates: true })
}

/** Écriture d'un paiement (journal BQ) : D 512/530, C 411 ; contre-passation inverse. */
export async function postPaymentEntry(tx: Tx, ctx: AccountingContext, paymentId: string): Promise<{ entryId: string; existing: boolean }> {
  const p = await tx.invoicePayment.findFirst({ where: { id: paymentId, companyId: ctx.companyId }, select: { id: true, amountCents: true, method: true, paidAt: true, reversesPaymentId: true, invoice: { select: { number: true, client: { select: { name: true } } } } } })
  if (!p) throw new PostingError("DOCUMENT_NOT_FOUND")
  const existing = await tx.accountingDocumentPosting.findFirst({ where: { companyId: ctx.companyId, sourceType: "PAYMENT", sourceId: p.id, sourceVersion: 1 }, select: { entryId: true } })
  if (existing) return { entryId: existing.entryId, existing: true }
  const bank = await accountId(tx, ctx, p.method === "CASH" ? ACCOUNTS.cash : ACCOUNTS.bank)
  const a411 = await accountId(tx, ctx, ACCOUNTS.clients)
  const label = `${p.reversesPaymentId ? "Annulation règlement" : "Règlement"} ${p.invoice.number} — ${p.invoice.client.name}`
  const lines = [side(bank, p.amountCents, BigInt(0), label), side(a411, BigInt(0), p.amountCents, label)].filter((l): l is LineInput => !!l)
  if (lines.length < 2) throw new PostingError("DOCUMENT_EMPTY")
  const draft = await createDraftEntry(tx, ctx, { journalId: await journalId(tx, ctx, "BQ"), fiscalYearId: await fiscalYearFor(tx, ctx, p.paidAt), entryDate: dayOf(p.paidAt), documentDate: dayOf(p.paidAt), documentRef: p.invoice.number, label, lines, source: { type: "PAYMENT", id: p.id, version: 1 } })
  await postEntry(tx, ctx, draft.id)
  await linkPosting(tx, ctx, "PAYMENT", p.id, draft.id)
  return { entryId: draft.id, existing: draft.existing }
}

/** Écriture d'une facture fournisseur validée (journal HA) : D 6xx HT, D 44566 TVA, C 401 TTC. */
export async function postSupplierInvoiceEntry(tx: Tx, ctx: AccountingContext, supplierInvoiceId: string): Promise<{ entryId: string; existing: boolean }> {
  const s = await tx.supplierInvoice.findFirst({ where: { id: supplierInvoiceId, companyId: ctx.companyId }, select: { id: true, number: true, supplierName: true, date: true, status: true, totalHTCents: true, vatCents: true, totalTTCCents: true, vatRateBp: true, expenseAccountId: true } })
  if (!s) throw new PostingError("DOCUMENT_NOT_FOUND")
  if (s.status !== "VALIDATED") throw new PostingError("DOCUMENT_NOT_VALIDATED", "Facture fournisseur non validée.")
  const existing = await tx.accountingDocumentPosting.findFirst({ where: { companyId: ctx.companyId, sourceType: "SUPPLIER_INVOICE", sourceId: s.id, sourceVersion: 1 }, select: { entryId: true } })
  if (existing) return { entryId: existing.entryId, existing: true }
  const expense = s.expenseAccountId ?? await accountId(tx, ctx, ACCOUNTS.defaultExpense)
  const exp = await tx.accountingAccount.findFirst({ where: { id: expense, companyId: ctx.companyId, active: true }, select: { id: true } })
  if (!exp) throw new PostingError("ACCOUNT_MISSING", "Compte de charge introuvable ou inactif.")
  const [a44566, a401] = await Promise.all([accountId(tx, ctx, ACCOUNTS.vatDeductible), accountId(tx, ctx, ACCOUNTS.suppliers)])
  const label = `Facture fournisseur ${s.number} — ${s.supplierName}`
  const lines = [side(exp.id, s.totalHTCents, BigInt(0), label), side(a44566, s.vatCents, BigInt(0), `${label} TVA`, s.vatRateBp), side(a401, BigInt(0), s.totalTTCCents, label)].filter((l): l is LineInput => !!l)
  if (lines.length < 2) throw new PostingError("DOCUMENT_EMPTY")
  const draft = await createDraftEntry(tx, ctx, { journalId: await journalId(tx, ctx, "HA"), fiscalYearId: await fiscalYearFor(tx, ctx, s.date), entryDate: dayOf(s.date), documentDate: dayOf(s.date), documentRef: s.number, label, lines, source: { type: "SUPPLIER_INVOICE", id: s.id, version: 1 } })
  await postEntry(tx, ctx, draft.id)
  await linkPosting(tx, ctx, "SUPPLIER_INVOICE", s.id, draft.id)
  return { entryId: draft.id, existing: draft.existing }
}

/** Lien pièce ↔ écriture (lecture pour les écrans). */
export async function findPostingFor(db: PrismaClient, ctx: { companyId: string }, sourceType: PostingSourceType, sourceId: string) {
  return db.accountingDocumentPosting.findFirst({ where: { companyId: ctx.companyId, sourceType, sourceId }, select: { entryId: true, entry: { select: { number: true, journal: { select: { code: true } } } } } })
}

/** Vue d'ensemble pour l'écran « Écritures depuis les factures » (société du contexte). */
export async function postingOverview(db: PrismaClient, ctx: { companyId: string }) {
  const [postings, invoices, payments, suppliers] = await Promise.all([
    db.accountingDocumentPosting.findMany({ where: { companyId: ctx.companyId }, select: { sourceType: true, sourceId: true, entryId: true, entry: { select: { number: true, journal: { select: { code: true } } } } } }),
    db.invoice.findMany({ where: { companyId: ctx.companyId, sentAt: { not: null } }, orderBy: { issueDate: "desc" }, take: 200, select: { id: true, number: true, kind: true, status: true, issueDate: true, totalTTC: true } }),
    db.invoicePayment.count({ where: { companyId: ctx.companyId } }),
    db.supplierInvoice.count({ where: { companyId: ctx.companyId, status: "VALIDATED" } }),
  ])
  return { postings, invoices, payments, suppliers }
}

export interface PostingReport { posted: number; existing: number; errors: { source: string; ref: string; error: string }[] }

/** Génère (idempotent) les écritures manquantes des pièces émises/validées de la société, par lots, avec rapport. */
export async function postMissingDocuments(db: PrismaClient, ctx: AccountingContext, limit = 200): Promise<PostingReport> {
  const report: PostingReport = { posted: 0, existing: 0, errors: [] }
  await runAccountingTransaction(db, (tx) => ensureBaseReferential(tx, ctx))
  // Les pièces déjà liées sont exclues en SQL AVANT la limite : chaque passage traite jusqu'à `limit` pièces non comptabilisées
  // par type ; relancer la génération jusqu'à « 0 générée » épuise l'arriéré.
  const posted = await db.accountingDocumentPosting.findMany({ where: { companyId: ctx.companyId }, select: { sourceType: true, sourceId: true } })
  const idsOf = (types: PostingSourceType[]) => posted.filter((p) => (types as string[]).includes(p.sourceType)).map((p) => p.sourceId)
  report.existing = posted.length
  const invoices = await db.invoice.findMany({ where: { companyId: ctx.companyId, status: { in: ["SENT", "PARTIAL", "PAID", "CANCELLED"] }, sentAt: { not: null }, id: { notIn: idsOf(["INVOICE", "CREDIT_NOTE", "DEPOSIT"]) } }, orderBy: { issueDate: "asc" }, select: { id: true, number: true, kind: true }, take: limit })
  const payments = await db.invoicePayment.findMany({ where: { companyId: ctx.companyId, id: { notIn: idsOf(["PAYMENT"]) } }, orderBy: { paidAt: "asc" }, select: { id: true, invoice: { select: { number: true } } }, take: limit })
  const suppliers = await db.supplierInvoice.findMany({ where: { companyId: ctx.companyId, status: "VALIDATED", id: { notIn: idsOf(["SUPPLIER_INVOICE"]) } }, orderBy: { date: "asc" }, select: { id: true, number: true }, take: limit })
  const jobs: { source: PostingSourceType; id: string; ref: string; run: (tx: Tx) => Promise<{ existing: boolean }> }[] = [
    ...invoices.map((i) => ({ source: (i.kind === "CREDIT_NOTE" ? "CREDIT_NOTE" : i.kind === "DEPOSIT" ? "DEPOSIT" : "INVOICE") as PostingSourceType, id: i.id, ref: i.number, run: (tx: Tx) => postInvoiceEntry(tx, ctx, i.id) })),
    ...payments.map((p) => ({ source: "PAYMENT" as PostingSourceType, id: p.id, ref: `règlement ${p.invoice.number}`, run: (tx: Tx) => postPaymentEntry(tx, ctx, p.id) })),
    ...suppliers.map((s) => ({ source: "SUPPLIER_INVOICE" as PostingSourceType, id: s.id, ref: s.number, run: (tx: Tx) => postSupplierInvoiceEntry(tx, ctx, s.id) })),
  ]
  for (const job of jobs) {
    try {
      const r = await runAccountingTransaction(db, job.run)
      if (r.existing) report.existing++; else report.posted++
    } catch (e) {
      const msg = e instanceof PostingError ? e.message : e instanceof AccountingError ? `Moteur comptable : ${e.code}` : "erreur"
      report.errors.push({ source: job.source, ref: job.ref, error: msg })
    }
  }
  return report
}

/** Génération automatique après un événement métier (drapeau ACCOUNTING_AUTO_POSTING_ENABLED) : jamais bloquante. */
export async function tryAutoPost(db: PrismaClient, ctx: AccountingContext, kind: "INVOICE" | "PAYMENT" | "SUPPLIER_INVOICE", id: string): Promise<void> {
  try {
    await runAccountingTransaction(db, (tx) => kind === "INVOICE" ? postInvoiceEntry(tx, ctx, id) : kind === "PAYMENT" ? postPaymentEntry(tx, ctx, id) : postSupplierInvoiceEntry(tx, ctx, id))
  } catch (e) {
    console.error("[comptabilite] écriture automatique non générée", kind, e instanceof Error ? e.message.slice(0, 120) : "erreur")
  }
}
