// ═══════════════════════════════════════════════════════════════════════════
// Banque et rapprochement (SPEC-BILLING-C5 §3.5) : import CSV (relevé unique par sha256, opérations identifiées — P2-01),
// rapprochement automatique et manuel. Société de session.
//
// Correctifs P1-03 / P1-04 (revue Codex du 26/10/2026) : un rapprochement est UNE SEULE transaction (runAccountingTransaction)
// qui 1) verrouille l'opération bancaire (FOR UPDATE), 2) verrouille la pièce cible (facture client via recordPaymentCore —
// verrou + plafond C2 ; facture fournisseur via FOR UPDATE), 3) vérifie état, société, sens et montant, 4) crée le paiement
// lié par `bankTransactionId` (UNIQUE en base) ou règle la facture fournisseur (montant exactement égal au TTC), 5) passe
// l'opération à MATCHED avec ses liens dans la même écriture. Tout refus après la première écriture lève LifecycleAbort ⇒
// ROLLBACK complet ; un refus avant toute écriture est un simple résultat. Plus aucune réservation à expiration.
// Ordre des verrous (documenté, identique partout) : opération bancaire → pièce cible (facture client ou facture fournisseur).
// L'écriture comptable (A1) reste HORS transaction métier : idempotente par source, rattrapable par « Générer les écritures manquantes ».
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from "node:crypto"
import type { Prisma, PrismaClient } from "@prisma/client"
import type { AccountingContext } from "@/lib/accounting/engine/posting"
import { runAccountingTransaction } from "@/lib/accounting/engine/transaction"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { recordPaymentTx } from "@/lib/billing/invoices/invoice.service"
import { centsToDecimalString, decimalToCents } from "@/lib/billing/money"
import { isBillingCompleteEnabled } from "@/lib/billing/billing-feature-flag"
import { LifecycleAbort, withLifecycleAbort } from "@/lib/billing/lifecycle-abort"
import { autoPostIfEnabled } from "./auto-post"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { MAX_BANK_BYTES, bankFingerprint, parseBankCsv, type BankColumnMapping } from "./bank-import"
import { settleSupplierInvoiceExact } from "./supplier-invoice.service"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export const MATCH_TOLERANCE_DAYS = 10

export const BANK_ERRORS = {
  notFound: "Opération bancaire introuvable.",
  notPending: "Cette opération est déjà rapprochée ou ignorée.",
  flagOff: "Le rapprochement avec une facture client nécessite la facturation complète (BILLING_COMPLETE_ENABLED).",
  debitOnInvoice: "Une opération débitrice ne règle pas une facture client.",
  creditOnSupplier: "Une opération créditrice ne règle pas une facture fournisseur.",
  supplierNotFound: "Facture fournisseur introuvable.",
  supplierNotValidated: "Seule une facture fournisseur validée peut être réglée.",
  supplierPaid: "Facture fournisseur déjà réglée.",
  supplierAmount: "Le montant de l'opération doit être exactement égal au TTC de la facture fournisseur (règlement intégral uniquement).",
  supplierConflict: "Facture fournisseur modifiée entre-temps : règlement annulé.",
  noTarget: "Cible de rapprochement manquante.",
} as const

export interface BankImportReport { importId: string; imported: number; duplicates: number; ambiguous: number; invalid: { row: number; error: string }[] }

export async function importBankStatement(db: Db, ctx: AccountingContext, text: string, fileName: string, mapping: BankColumnMapping): Promise<LifecycleResult<BankImportReport>> {
  if (Buffer.byteLength(text, "utf8") > MAX_BANK_BYTES) return { ok: false, error: "Fichier trop volumineux (2 Mo maximum)." }
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex")
  const ALREADY = "Ce relevé a déjà été importé."
  const parsed = parseBankCsv(ctx.companyId, text, mapping)
  if (parsed.lines.length === 0) return { ok: false, error: parsed.invalid[0]?.error ? `Aucune ligne valide (${parsed.invalid[0].error}).` : "Aucune ligne valide." }
  // Deux imports concurrents de relevés qui se chevauchent peuvent insérer la même empreinte au même instant : la contrainte
  // unique (companyId, fingerprint) refuse le second, qui est REJOUÉ (l'empreinte est alors connue ⇒ doublon) : jamais deux opérations.
  const report = await retryOnUniqueViolation(() => db.$transaction(async (tx): Promise<BankImportReport | "ALREADY"> => {
    // Contrôle du relevé DANS la fermeture rejouée : deux imports simultanés du même fichier ⇒ le second voit le premier committé.
    if (await tx.bankStatementImport.findFirst({ where: { companyId: ctx.companyId, sha256 }, select: { id: true } })) return "ALREADY"
    const imp = await tx.bankStatementImport.create({ data: { companyId: ctx.companyId, fileName: fileName.slice(0, 200), sha256, rowCount: parsed.lines.length, mapping: mapping as unknown as Prisma.InputJsonValue, importedById: ctx.userId }, select: { id: true } })
    // Identité : empreinte (identifiant bancaire, ou tuple + occurrence) déjà présente pour la société ⇒ même opération, ignorée.
    const known = new Set((await tx.bankTransaction.findMany({ where: { companyId: ctx.companyId, fingerprint: { in: parsed.lines.map((l) => l.fingerprint) } }, select: { fingerprint: true } })).map((k) => k.fingerprint))
    const fresh = parsed.lines.filter((l) => !known.has(l.fingerprint))
    if (fresh.length) await tx.bankTransaction.createMany({ data: fresh.map((l) => ({ companyId: ctx.companyId, importId: imp.id, date: l.date, label: l.label, amountCents: l.amountCents, reference: l.reference, fingerprint: l.fingerprint, externalId: l.externalId, occurrence: l.occurrence, identityAmbiguous: l.identityAmbiguous, status: "PENDING" })) })
    // Un tuple désormais connu comme répété rend AMBIGUËS ses occurrences inférieures déjà importées (encore PENDING) : plus de
    // rapprochement automatique sur une identité devenue incertaine, même si elles venaient d'un relevé antérieur.
    const repeated = parsed.lines.filter((l) => l.identityAmbiguous && !l.externalId)
    if (repeated.length) {
      const bases = [...new Set(repeated.flatMap((l) => { const out: string[] = []; for (let k = 1; k < l.occurrence; k++) out.push(bankFingerprint(ctx.companyId, l.date, l.amountCents, l.label, l.reference, k)); return out }))]
      if (bases.length) await tx.bankTransaction.updateMany({ where: { companyId: ctx.companyId, fingerprint: { in: bases }, status: "PENDING", identityAmbiguous: false }, data: { identityAmbiguous: true } })
    }
    const ambiguous = fresh.filter((l) => l.identityAmbiguous).length
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "CREATED", entityType: "BankStatementImport", entityId: imp.id, detail: `Relevé ${fileName} importé : ${fresh.length} opération(s), ${parsed.lines.length - fresh.length} doublon(s)${ambiguous ? `, ${ambiguous} à identité ambiguë (rapprochement manuel)` : ""}` } })
    await flushDeferredConstraints(tx)
    return { importId: imp.id, imported: fresh.length, duplicates: parsed.lines.length - fresh.length, ambiguous, invalid: parsed.invalid }
  }))
  if (report === "ALREADY") return { ok: false, error: ALREADY }
  return { ok: true, value: report }
}

async function retryOnUniqueViolation<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn() } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== "P2002" || i >= attempts) throw e
    }
  }
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
  const t = await db.bankTransaction.findFirst({ where: { id: txId, companyId }, select: { id: true, date: true, amountCents: true, reference: true, label: true, status: true, identityAmbiguous: true } })
  if (!t) return null
  const open = items ?? await loadOpenItems(db, ctx)
  if (t.amountCents > BigInt(0)) {
    const invoices = open.invoices
      .map((i) => ({ ...i, exact: i.remainingCents === t.amountCents, refMatch: !!(t.reference ?? "").toUpperCase().includes(i.number.toUpperCase()) || t.label.toUpperCase().includes(i.number.toUpperCase()), dateMatch: dayDiff(t.date, i.dueDate ?? i.issueDate) <= MATCH_TOLERANCE_DAYS }))
      .sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.refMatch) - Number(a.refMatch) || Number(b.dateMatch) - Number(a.dateMatch))
    return { transaction: t, invoices, supplierInvoices: [] as (OpenSupplier & { exact: boolean })[] }
  }
  const abs = -t.amountCents
  return { transaction: t, invoices: [] as (OpenInvoice & { exact: boolean; refMatch: boolean; dateMatch: boolean })[], supplierInvoices: open.suppliers.map((s) => ({ ...s, exact: s.totalTTCCents === abs })).sort((a, b) => Number(b.exact) - Number(a.exact)) }
}

export interface ReconcileReport { matched: number; unmatched: number; ambiguous: number; errors: { transactionId: string; error: string }[] }

/**
 * Rapprochement automatique : montant exact ET (référence/libellé contient le n° OU date à ± tolérance) ; une seule candidate.
 * P2-01 : une opération à identité ambiguë n'est JAMAIS rapprochée automatiquement (aucun paiement incertain) : rapprochement manuel.
 */
export async function autoReconcile(db: Db, ctx: AccountingContext, limit = 500): Promise<ReconcileReport> {
  const pending = await db.bankTransaction.findMany({ where: { companyId: ctx.companyId, status: "PENDING" }, orderBy: { date: "asc" }, take: limit, select: { id: true, identityAmbiguous: true } })
  const report: ReconcileReport = { matched: 0, unmatched: 0, ambiguous: 0, errors: [] }
  let items = await loadOpenItems(db, ctx)
  for (const p of pending) {
    if (p.identityAmbiguous) { report.ambiguous++; continue }
    const c = await matchCandidates(db, ctx, p.id, items)
    if (!c) continue
    const exactInv = c.invoices.filter((i) => i.exact && (i.refMatch || i.dateMatch))
    const exactSup = c.supplierInvoices.filter((s) => s.exact)
    try {
      const target = exactInv.length === 1 ? { invoiceId: exactInv[0].id } : exactSup.length === 1 && c.transaction.amountCents < BigInt(0) ? { supplierInvoiceId: exactSup[0].id } : null
      if (!target) { report.unmatched++; continue }
      const r = await matchTransaction(db, ctx, p.id, target)
      if (r.ok) { report.matched++; items = await loadOpenItems(db, ctx) } else report.errors.push({ transactionId: p.id, error: r.error })
    } catch (e) { report.errors.push({ transactionId: p.id, error: e instanceof Error ? e.message.slice(0, 120) : "erreur" }) }
  }
  return report
}

/** Points d'interruption réservés aux tests PostgreSQL (simulation d'une panne au milieu ou après la transaction). Jamais actifs en production. */
export interface BankReconcileTestHooks {
  afterPaymentCreated?: (tx: Tx, paymentId: string) => Promise<void>
  afterSupplierSettled?: (tx: Tx, supplierInvoiceId: string) => Promise<void>
  afterMatched?: (tx: Tx, transactionId: string) => Promise<void>
  afterCommit?: (transactionId: string) => Promise<void>
}
let testHooks: BankReconcileTestHooks | null = null
export function setBankReconcileHooksForTests(hooks: BankReconcileTestHooks | null): void { testHooks = hooks }

async function lockBankTransaction(tx: Tx, txId: string, companyId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "bank_transactions" WHERE "id" = ${txId} AND "companyId" = ${companyId} FOR UPDATE`
}
async function lockSupplierInvoice(tx: Tx, id: string, companyId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "supplier_invoices" WHERE "id" = ${id} AND "companyId" = ${companyId} FOR UPDATE`
}

export interface MatchTarget { invoiceId?: string; supplierInvoiceId?: string; ignore?: boolean; notes?: string | null }

/**
 * Rapprochement d'une opération, en UNE transaction :
 * - facture client (créditrice) ⇒ paiement C2 (verrou de la facture, montant = montant de l'opération, refus au-delà du reste
 *   à payer, PARTIAL/PAID recalculé) lié par `bankTransactionId` (unique) puis MATCHED avec paiement et facture dans la même écriture ;
 * - facture fournisseur (débitrice) ⇒ verrou de la facture, société, VALIDATED, impayée, montant absolu = TTC ; MATCHED et `paidAt`
 *   dans la même transaction (règlement intégral uniquement, pas de règlement partiel fournisseur) ;
 * - « ignorer » ⇒ IGNORED (instruction conditionnelle unique).
 * Un refus après la première écriture lève LifecycleAbort ⇒ ROLLBACK ; converti en { ok: false } hors transaction.
 * Rejeu d'une opération déjà rapprochée ⇒ { ok: false, notPending } sans effet.
 */
export async function matchTransaction(db: Db, ctx: AccountingContext, txId: string, target: MatchTarget): Promise<LifecycleResult<{ status: string }>> {
  if (target.ignore) {
    const u = await db.bankTransaction.updateMany({ where: { id: txId, companyId: ctx.companyId, status: "PENDING" }, data: { status: "IGNORED", matchedAt: new Date(), notes: target.notes ?? null } })
    if (u.count === 1) return { ok: true, value: { status: "IGNORED" } }
    const exists = await db.bankTransaction.findFirst({ where: { id: txId, companyId: ctx.companyId }, select: { id: true } })
    return { ok: false, error: exists ? BANK_ERRORS.notPending : BANK_ERRORS.notFound }
  }
  if (!target.invoiceId && !target.supplierInvoiceId) return { ok: false, error: BANK_ERRORS.noTarget }
  // Les paiements de factures client relèvent de la facturation complète (C2) : jamais sans son drapeau.
  if (target.invoiceId && !isBillingCompleteEnabled()) return { ok: false, error: BANK_ERRORS.flagOff }
  const now = new Date()
  const r = await withLifecycleAbort(() => runAccountingTransaction(db, async (tx): Promise<LifecycleResult<{ status: string; paymentId: string | null }>> => {
    // Verrou 1 : l'opération bancaire (puis relecture sous verrou).
    await lockBankTransaction(tx, txId, ctx.companyId)
    const t = await tx.bankTransaction.findFirst({ where: { id: txId, companyId: ctx.companyId }, select: { id: true, status: true, date: true, amountCents: true, reference: true, label: true } })
    if (!t) return { ok: false, error: BANK_ERRORS.notFound }
    if (t.status !== "PENDING") return { ok: false, error: BANK_ERRORS.notPending }
    let paymentId: string | null = null
    let detail: string
    if (target.invoiceId) {
      if (t.amountCents <= BigInt(0)) return { ok: false, error: BANK_ERRORS.debitOnInvoice }
      // Verrou 2 : la facture (recordPaymentCore : FOR UPDATE, plafond du reste à payer, société). Un refus ici n'a rien écrit.
      const p = await recordPaymentTx(tx, { companyId: ctx.companyId, userId: ctx.userId }, target.invoiceId, { amountCents: t.amountCents, method: "TRANSFER", paidAt: t.date, reference: (t.reference ?? t.label).slice(0, 100), notes: `Rapprochement bancaire ${t.id}`, bankTransactionId: t.id }, now)
      if (!p.ok) return p
      paymentId = p.value.paymentId
      if (testHooks?.afterPaymentCreated) await testHooks.afterPaymentCreated(tx, paymentId)
      const claimed = await tx.bankTransaction.updateMany({ where: { id: t.id, companyId: ctx.companyId, status: "PENDING" }, data: { status: "MATCHED", matchedInvoiceId: target.invoiceId, matchedPaymentId: paymentId, matchedAt: now, notes: target.notes ?? null } })
      if (claimed.count !== 1) throw new LifecycleAbort(BANK_ERRORS.notPending)
      detail = `Opération bancaire ${t.id} (${centsToDecimalString(t.amountCents)} €) rapprochée avec la facture ${target.invoiceId} — paiement ${paymentId} (${p.value.status}, reste ${centsToDecimalString(p.value.remainingCents)} €)`
    } else {
      const supplierInvoiceId = target.supplierInvoiceId as string
      if (t.amountCents >= BigInt(0)) return { ok: false, error: BANK_ERRORS.creditOnSupplier }
      // Verrou 2 : la facture fournisseur, puis contrôles sous verrou (société via le filtre, statut, impayée, montant exact).
      await lockSupplierInvoice(tx, supplierInvoiceId, ctx.companyId)
      const s = await tx.supplierInvoice.findFirst({ where: { id: supplierInvoiceId, companyId: ctx.companyId }, select: { id: true, number: true, status: true, paidAt: true, totalTTCCents: true } })
      if (!s) return { ok: false, error: BANK_ERRORS.supplierNotFound }
      if (s.status !== "VALIDATED") return { ok: false, error: BANK_ERRORS.supplierNotValidated }
      if (s.paidAt) return { ok: false, error: BANK_ERRORS.supplierPaid }
      if (-t.amountCents !== s.totalTTCCents) return { ok: false, error: `${BANK_ERRORS.supplierAmount} (TTC : ${centsToDecimalString(s.totalTTCCents)} €, opération : ${centsToDecimalString(-t.amountCents)} €)` }
      const claimed = await tx.bankTransaction.updateMany({ where: { id: t.id, companyId: ctx.companyId, status: "PENDING" }, data: { status: "MATCHED", matchedSupplierInvoiceId: s.id, matchedAt: now, notes: target.notes ?? null } })
      if (claimed.count !== 1) throw new LifecycleAbort(BANK_ERRORS.notPending)
      // Un échec ici (facture modifiée entre-temps) LÈVE ⇒ ROLLBACK des deux objets.
      await settleSupplierInvoiceExact(tx, ctx.companyId, s.id, t.date)
      if (testHooks?.afterSupplierSettled) await testHooks.afterSupplierSettled(tx, s.id)
      detail = `Opération bancaire ${t.id} (${centsToDecimalString(t.amountCents)} €) rapprochée avec la facture fournisseur ${s.number} — réglée en totalité`
    }
    await tx.historyLog.create({ data: { companyId: ctx.companyId, actorId: ctx.userId, action: "UPDATED", entityType: "BankTransaction", entityId: t.id, detail } })
    if (testHooks?.afterMatched) await testHooks.afterMatched(tx, t.id)
    await flushDeferredConstraints(tx)
    return { ok: true, value: { status: "MATCHED", paymentId } }
  }))
  if (!r.ok) return r
  if (testHooks?.afterCommit) await testHooks.afterCommit(txId)
  // Écriture comptable du paiement : hors transaction, idempotente et non bloquante (rattrapable par « Générer les écritures manquantes »).
  if (r.value.paymentId) await autoPostIfEnabled(db, { companyId: ctx.companyId, userId: ctx.userId }, "PAYMENT", r.value.paymentId)
  return { ok: true, value: { status: r.value.status } }
}

export async function listBankTransactions(db: Db, ctx: { companyId: string }, f: { status?: "PENDING" | "MATCHED" | "IGNORED"; page?: number }) {
  const companyId = ctx.companyId
  const where: Prisma.BankTransactionWhereInput = { companyId, ...(f.status ? { status: f.status } : {}) }
  const page = Math.max(1, Math.min(10_000, Math.trunc(f.page ?? 1)))
  const [total, rows, summary] = await Promise.all([
    db.bankTransaction.count({ where }),
    db.bankTransaction.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], skip: (page - 1) * 100, take: 100, select: { id: true, date: true, label: true, amountCents: true, reference: true, status: true, matchedAt: true, notes: true, externalId: true, occurrence: true, identityAmbiguous: true, matchedInvoice: { select: { id: true, number: true } }, matchedSupplierInvoice: { select: { id: true, number: true, supplierName: true } } } }),
    db.bankTransaction.groupBy({ by: ["status"], where: { companyId }, _count: { _all: true } }),
  ])
  return { total, page, pageSize: 100, rows, counts: Object.fromEntries(summary.map((s) => [s.status, s._count._all])) as Record<string, number> }
}
