// ═══════════════════════════════════════════════════════════════════════════
// Banque et rapprochement (SPEC-BILLING-C5 §3.5) : import CSV (relevé unique par sha256, lignes uniques par empreinte),
// rapprochement automatique (montant + référence/date ⇒ paiement C2 ou facture fournisseur payée) et manuel. Société de session.
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from "node:crypto"
import type { Prisma, PrismaClient } from "@prisma/client"
import type { AccountingContext } from "@/lib/accounting/engine/posting"
import { recordPayment } from "@/lib/billing/invoices/invoice.service"
import { decimalToCents } from "@/lib/billing/money"
import { isBillingCompleteEnabled } from "@/lib/billing/billing-feature-flag"
import { autoPostIfEnabled } from "./auto-post"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { MAX_BANK_BYTES, parseBankCsv, type BankColumnMapping } from "./bank-import"
import { markSupplierInvoicePaid } from "./supplier-invoice.service"

type Db = PrismaClient
export const MATCH_TOLERANCE_DAYS = 10

export interface BankImportReport { importId: string; imported: number; duplicates: number; invalid: { row: number; error: string }[] }

export async function importBankStatement(db: Db, ctx: AccountingContext, text: string, fileName: string, mapping: BankColumnMapping): Promise<LifecycleResult<BankImportReport>> {
  if (Buffer.byteLength(text, "utf8") > MAX_BANK_BYTES) return { ok: false, error: "Fichier trop volumineux (2 Mo maximum)." }
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex")
  const existing = await db.bankStatementImport.findFirst({ where: { companyId: ctx.companyId, sha256 }, select: { id: true } })
  if (existing) return { ok: false, error: "Ce relevé a déjà été importé." }
  const parsed = parseBankCsv(ctx.companyId, text, mapping)
  if (parsed.lines.length === 0) return { ok: false, error: parsed.invalid[0]?.error ? `Aucune ligne valide (${parsed.invalid[0].error}).` : "Aucune ligne valide." }
  const report = await db.$transaction(async (tx) => {
    const imp = await tx.bankStatementImport.create({ data: { companyId: ctx.companyId, fileName: fileName.slice(0, 200), sha256, rowCount: parsed.lines.length, mapping: mapping as unknown as Prisma.InputJsonValue, importedById: ctx.userId }, select: { id: true } })
    const known = new Set((await tx.bankTransaction.findMany({ where: { companyId: ctx.companyId, fingerprint: { in: parsed.lines.map((l) => l.fingerprint) } }, select: { fingerprint: true } })).map((k) => k.fingerprint))
    const fresh = parsed.lines.filter((l) => !known.has(l.fingerprint))
    const seen = new Set<string>()
    const unique = fresh.filter((l) => (seen.has(l.fingerprint) ? false : (seen.add(l.fingerprint), true)))
    if (unique.length) await tx.bankTransaction.createMany({ data: unique.map((l) => ({ companyId: ctx.companyId, importId: imp.id, date: l.date, label: l.label, amountCents: l.amountCents, reference: l.reference, fingerprint: l.fingerprint, status: "PENDING" })) })
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "CREATED", entityType: "BankStatementImport", entityId: imp.id, detail: `Relevé ${fileName} importé : ${unique.length} opération(s), ${parsed.lines.length - unique.length} doublon(s)` } })
    return { importId: imp.id, imported: unique.length, duplicates: parsed.lines.length - unique.length, invalid: parsed.invalid }
  })
  return { ok: true, value: report }
}

const dayDiff = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 86_400_000

type OpenInvoice = { id: string; number: string; clientName: string; issueDate: Date; dueDate: Date | null; remainingCents: bigint }
type OpenSupplier = { id: string; number: string; supplierName: string; date: Date; totalTTCCents: bigint }

/** Factures émises non soldées (reste = TTC − paiements − avoirs partiels) et factures fournisseurs validées impayées. */
export async function loadOpenItems(db: Db, ctx: { companyId: string }): Promise<{ invoices: OpenInvoice[]; suppliers: OpenSupplier[] }> {
  const open = await db.invoice.findMany({ where: { companyId: ctx.companyId, status: { in: ["SENT", "PARTIAL"] }, kind: { not: "CREDIT_NOTE" } }, select: { id: true, number: true, issueDate: true, dueDate: true, totalTTC: true, client: { select: { name: true } }, payments: { select: { amountCents: true } }, creditNotes: { where: { creditScope: "PARTIAL", status: { not: "CANCELLED" } }, select: { totalTTC: true } } } })
  const invoices = open.map((i) => ({ id: i.id, number: i.number, clientName: i.client.name, issueDate: i.issueDate, dueDate: i.dueDate, remainingCents: decimalToCents(i.totalTTC) - i.payments.reduce((s, p) => s + p.amountCents, BigInt(0)) - i.creditNotes.reduce((s, c) => s + decimalToCents(c.totalTTC), BigInt(0)) })).filter((i) => i.remainingCents > BigInt(0))
  const suppliers = await db.supplierInvoice.findMany({ where: { companyId: ctx.companyId, status: "VALIDATED", paidAt: null }, select: { id: true, number: true, supplierName: true, date: true, totalTTCCents: true } })
  return { invoices, suppliers }
}

/** Candidats pour une opération (chargement des pièces ouvertes injectable pour éviter N+1 en rapprochement automatique). */
export async function matchCandidates(db: Db, ctx: { companyId: string }, txId: string, items?: { invoices: OpenInvoice[]; suppliers: OpenSupplier[] }) {
  const companyId = ctx.companyId
  const t = await db.bankTransaction.findFirst({ where: { id: txId, companyId }, select: { id: true, date: true, amountCents: true, reference: true, label: true, status: true } })
  if (!t) return null
  const open = items ?? await loadOpenItems(db, ctx)
  if (t.amountCents > BigInt(0)) {
    const invoices = open.invoices
      .map((i) => ({ ...i, exact: i.remainingCents === t.amountCents, refMatch: !!(t.reference ?? "").toUpperCase().includes(i.number.toUpperCase()) || t.label.toUpperCase().includes(i.number.toUpperCase()), dateMatch: dayDiff(t.date, i.dueDate ?? i.issueDate) <= MATCH_TOLERANCE_DAYS }))
      .sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.refMatch) - Number(a.refMatch) || Number(b.dateMatch) - Number(a.dateMatch))
    return { transaction: t, invoices, supplierInvoices: [] as { id: string; number: string; supplierName: string; date: Date; totalTTCCents: bigint; exact: boolean }[] }
  }
  const abs = -t.amountCents
  return { transaction: t, invoices: [], supplierInvoices: open.suppliers.map((s) => ({ ...s, exact: s.totalTTCCents === abs })).sort((a, b) => Number(b.exact) - Number(a.exact)) }
}

export interface ReconcileReport { matched: number; unmatched: number; errors: { transactionId: string; error: string }[] }

/** Rapprochement automatique : montant exact ET (référence/libellé contient le n° OU date à ± tolérance) ; une seule candidate. */
export async function autoReconcile(db: Db, ctx: AccountingContext, limit = 500): Promise<ReconcileReport> {
  await repairStaleMatches(db, ctx)
  const pending = await db.bankTransaction.findMany({ where: { companyId: ctx.companyId, status: "PENDING" }, orderBy: { date: "asc" }, take: limit, select: { id: true } })
  const report: ReconcileReport = { matched: 0, unmatched: 0, errors: [] }
  let items = await loadOpenItems(db, ctx)
  for (const p of pending) {
    const c = await matchCandidates(db, ctx, p.id, items)
    if (!c) continue
    const exactInv = c.invoices.filter((i) => i.exact && (i.refMatch || i.dateMatch))
    const exactSup = c.supplierInvoices.filter((s) => s.exact)
    try {
      if (exactInv.length === 1) { const r = await matchTransaction(db, ctx, p.id, { invoiceId: exactInv[0].id }); if (r.ok) { report.matched++; items = await loadOpenItems(db, ctx) } else report.errors.push({ transactionId: p.id, error: r.error }) }
      else if (exactSup.length === 1 && c.transaction.amountCents < BigInt(0)) { const r = await matchTransaction(db, ctx, p.id, { supplierInvoiceId: exactSup[0].id }); if (r.ok) report.matched++; else report.errors.push({ transactionId: p.id, error: r.error }) }
      else report.unmatched++
    } catch (e) { report.errors.push({ transactionId: p.id, error: e instanceof Error ? e.message.slice(0, 120) : "erreur" }) }
  }
  return report
}

/**
 * Rapprochement d'une opération : facture client ⇒ enregistrement du paiement (C2 : verrou, plafond) puis MATCHED ;
 * facture fournisseur ⇒ marquée payée ; « ignorer » ⇒ IGNORED. Jamais deux paiements pour une même ligne (statut conditionnel).
 */
export async function matchTransaction(db: Db, ctx: AccountingContext, txId: string, target: { invoiceId?: string; supplierInvoiceId?: string; ignore?: boolean; notes?: string | null }): Promise<LifecycleResult<{ status: string }>> {
  const t = await db.bankTransaction.findFirst({ where: { id: txId, companyId: ctx.companyId }, select: { id: true, status: true, date: true, amountCents: true, reference: true, label: true } })
  if (!t) return { ok: false, error: "Opération bancaire introuvable." }
  if (t.status !== "PENDING") return { ok: false, error: "Cette opération est déjà rapprochée ou ignorée." }
  if (target.ignore) {
    const u = await db.bankTransaction.updateMany({ where: { id: t.id, companyId: ctx.companyId, status: "PENDING" }, data: { status: "IGNORED", matchedAt: new Date(), notes: target.notes ?? null } })
    return u.count === 1 ? { ok: true, value: { status: "IGNORED" } } : { ok: false, error: "Opération modifiée entre-temps." }
  }
  if (target.invoiceId) {
    // Les paiements de factures client relèvent de la facturation complète (C2) : jamais sans son drapeau.
    if (!isBillingCompleteEnabled()) return { ok: false, error: "Le rapprochement avec une facture client nécessite la facturation complète (BILLING_COMPLETE_ENABLED)." }
    if (t.amountCents <= BigInt(0)) return { ok: false, error: "Une opération débitrice ne règle pas une facture client." }
    // Réservation conditionnelle de l'opération AVANT le paiement : une seconde tentative concurrente échoue ici.
    const claimed = await db.bankTransaction.updateMany({ where: { id: t.id, companyId: ctx.companyId, status: "PENDING" }, data: { status: "MATCHED", matchedInvoiceId: target.invoiceId, matchedAt: new Date(), notes: target.notes ?? null } })
    if (claimed.count !== 1) return { ok: false, error: "Opération modifiée entre-temps." }
    const r = await recordPayment(db, { companyId: ctx.companyId, userId: ctx.userId }, target.invoiceId, { amountCents: t.amountCents, method: "TRANSFER", paidAt: t.date, reference: (t.reference ?? t.label).slice(0, 100), notes: `Rapprochement bancaire ${t.id}` }, new Date())
    if (!r.ok) {
      await db.bankTransaction.updateMany({ where: { id: t.id, companyId: ctx.companyId, status: "MATCHED", matchedPaymentId: null }, data: { status: "PENDING", matchedInvoiceId: null, matchedAt: null } })
      return { ok: false, error: r.error }
    }
    await db.bankTransaction.updateMany({ where: { id: t.id, companyId: ctx.companyId }, data: { matchedPaymentId: r.value.paymentId } })
    await autoPostIfEnabled(db, { companyId: ctx.companyId, userId: ctx.userId }, "PAYMENT", r.value.paymentId)
    return { ok: true, value: { status: "MATCHED" } }
  }
  if (target.supplierInvoiceId) {
    if (t.amountCents >= BigInt(0)) return { ok: false, error: "Une opération créditrice ne règle pas une facture fournisseur." }
    const s = await db.supplierInvoice.findFirst({ where: { id: target.supplierInvoiceId, companyId: ctx.companyId, status: "VALIDATED" }, select: { id: true, paidAt: true } })
    if (!s) return { ok: false, error: "Facture fournisseur introuvable ou non validée." }
    if (s.paidAt) return { ok: false, error: "Facture fournisseur déjà payée." }
    const r = await db.$transaction(async (tx) => {
      const claimed = await tx.bankTransaction.updateMany({ where: { id: t.id, companyId: ctx.companyId, status: "PENDING" }, data: { status: "MATCHED", matchedSupplierInvoiceId: s.id, matchedAt: new Date(), notes: target.notes ?? null } })
      if (claimed.count !== 1) return false
      return markSupplierInvoicePaid(tx, ctx.companyId, s.id, t.date)
    })
    return r ? { ok: true, value: { status: "MATCHED" } } : { ok: false, error: "Opération ou facture modifiée entre-temps." }
  }
  return { ok: false, error: "Cible de rapprochement manquante." }
}

/** Reprise : une opération réservée (MATCHED facture) sans paiement rattaché depuis plus de 5 minutes revient à PENDING. */
export async function repairStaleMatches(db: Db, ctx: { companyId: string }): Promise<number> {
  const r = await db.bankTransaction.updateMany({ where: { companyId: ctx.companyId, status: "MATCHED", matchedInvoiceId: { not: null }, matchedPaymentId: null, matchedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, data: { status: "PENDING", matchedInvoiceId: null, matchedAt: null } })
  return r.count
}

export async function listBankTransactions(db: Db, ctx: { companyId: string }, f: { status?: "PENDING" | "MATCHED" | "IGNORED"; page?: number }) {
  const companyId = ctx.companyId
  const where: Prisma.BankTransactionWhereInput = { companyId, ...(f.status ? { status: f.status } : {}) }
  const page = Math.max(1, Math.min(10_000, Math.trunc(f.page ?? 1)))
  const [total, rows, summary] = await Promise.all([
    db.bankTransaction.count({ where }),
    db.bankTransaction.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], skip: (page - 1) * 100, take: 100, select: { id: true, date: true, label: true, amountCents: true, reference: true, status: true, matchedAt: true, notes: true, matchedInvoice: { select: { id: true, number: true } }, matchedSupplierInvoice: { select: { id: true, number: true, supplierName: true } } } }),
    db.bankTransaction.groupBy({ by: ["status"], where: { companyId }, _count: { _all: true } }),
  ])
  return { total, page, pageSize: 100, rows, counts: Object.fromEntries(summary.map((s) => [s.status, s._count._all])) as Record<string, number> }
}
