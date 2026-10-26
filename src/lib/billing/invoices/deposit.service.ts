// ═══════════════════════════════════════════════════════════════════════════
// Acomptes — Lot C3 : création d'une facture d'acompte depuis un devis accepté/converti (verrou, plafond),
// déductions sur la facture de solde (lignes négatives identifiées + table de liaison), contrôles d'émission.
// ═══════════════════════════════════════════════════════════════════════════
import type { Prisma, PrismaClient } from "@prisma/client"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { MoneyError, bpToPercentString, centsToDecimalString, computeDocumentTotals, decimalToCents, storedVatRateToBp, vatCents } from "@/lib/billing/money"
import { getBillingSettings } from "@/lib/billing/settings"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { lockQuoteRow } from "@/lib/billing/quotes/quote.service"
import { buildDeductionLines, computeDepositLines, depositDesignation, depositTotal, type DepositRequest, type IssuedDeposit } from "./deposit.core"

type Db = PrismaClient
type Tx = Prisma.TransactionClient
export interface DepositContext { companyId: string; userId: string }

export const DEPOSIT_ERRORS = {
  quoteNotFound: "Devis introuvable.",
  quoteNotAccepted: "Un acompte ne se crée que sur un devis accepté ou converti.",
  finalIssued: "La facture de solde est déjà émise : plus d'acompte possible.",
  ceiling: "Le total des acomptes dépasserait le montant TTC du devis.",
  emptyQuote: "Le devis n'a aucune ligne facturable.",
  notFinalDraft: "Les déductions ne se recalculent que sur une facture de solde en brouillon.",
  depositDraft: "Un acompte de ce devis est encore en brouillon : émettez-le ou abandonnez-le avant d'émettre le solde.",
  depositNotDeducted: "Des acomptes émis ne sont pas déduits : recalculez les déductions avant d'émettre le solde.",
  deductionMismatch: "Les déductions d'acomptes ne correspondent plus aux acomptes émis : recalculez-les.",
} as const

const quoteSummarySelect = {
  id: true, number: true, status: true, companyId: true, worksiteId: true, clientId: true, globalDiscountBp: true, vatReverseCharge: true, totalTTC: true, paymentTerms: true,
  worksite: { select: { startDate: true, endDate: true } },
  lines: { select: { quantity: true, unitPrice: true, vatRate: true, discountBp: true } },
} satisfies Prisma.QuoteSelect

async function depositsTotalCents(tx: Tx, companyId: string, quoteId: string, excludeId?: string): Promise<bigint> {
  const rows = await tx.invoice.findMany({ where: { companyId, quoteId, kind: "DEPOSIT", status: { not: "CANCELLED" }, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { totalTTC: true } })
  return rows.reduce((s, r) => s + decimalToCents(r.totalTTC), BigInt(0))
}

/** Crée un brouillon de facture d'acompte (numéro provisoire) : verrou du devis, plafond, ventilation par taux. */
export async function createDepositInvoice(db: Db, ctx: DepositContext, quoteId: string, request: DepositRequest, now: Date): Promise<LifecycleResult<{ id: string; number: string; ttcCents: bigint }>> {
  const s = await getBillingSettings(db, ctx.companyId)
  return db.$transaction(async (tx) => {
    await lockQuoteRow(tx, quoteId, ctx.companyId)
    const q = await tx.quote.findFirst({ where: { id: quoteId, companyId: ctx.companyId }, select: quoteSummarySelect })
    if (!q) return { ok: false, error: DEPOSIT_ERRORS.quoteNotFound }
    if (q.status !== "ACCEPTED" && q.status !== "CONVERTED") return { ok: false, error: DEPOSIT_ERRORS.quoteNotAccepted }
    const finalIssued = await tx.invoice.findFirst({ where: { companyId: ctx.companyId, quoteId, kind: "INVOICE", status: { in: ["SENT", "PARTIAL", "PAID"] } }, select: { id: true } })
    if (finalIssued) return { ok: false, error: DEPOSIT_ERRORS.finalIssued }
    const totals = computeDocumentTotals(
      q.lines.map((l) => ({ quantityHundredths: decimalToCents(l.quantity), unitPriceCents: decimalToCents(l.unitPrice), discountBp: l.discountBp, vatRateBp: storedVatRateToBp(l.vatRate) })),
      { globalDiscountBp: q.globalDiscountBp, vatReverseCharge: q.vatReverseCharge },
    )
    let lines
    try { lines = computeDepositLines(totals.vatSummary, request, q.vatReverseCharge) }
    catch (e) {
      if (e instanceof MoneyError) return { ok: false, error: e.code === "DEPOSIT_EMPTY_QUOTE" ? DEPOSIT_ERRORS.emptyQuote : e.code === "DEPOSIT_EXCEEDS_QUOTE" ? DEPOSIT_ERRORS.ceiling : "Montant d'acompte invalide." }
      throw e
    }
    const t = depositTotal(lines)
    if (t.ttcCents <= BigInt(0)) return { ok: false, error: "Montant d'acompte invalide." }
    const already = await depositsTotalCents(tx, ctx.companyId, quoteId)
    if (already + t.ttcCents > totals.totalTTCCents) return { ok: false, error: DEPOSIT_ERRORS.ceiling }
    const number = await nextDocumentNumber(tx, ctx.companyId, "INVOICE_DRAFT", now.getUTCFullYear())
    const inv = await tx.invoice.create({
      data: {
        companyId: ctx.companyId, worksiteId: q.worksiteId, clientId: q.clientId, quoteId: q.id, number, status: "DRAFT", kind: "DEPOSIT",
        issueDate: now, dueDate: new Date(now.getTime() + s.paymentTermsDays * 86_400_000), periodStart: q.worksite.startDate, periodEnd: q.worksite.endDate,
        subject: `Acompte sur le devis ${q.number}`, paymentTerms: q.paymentTerms, vatReverseCharge: q.vatReverseCharge, globalDiscountBp: 0,
        depositBp: request.kind === "PERCENT" ? request.bp : null, createdById: ctx.userId,
        totalHT: centsToDecimalString(t.htCents), totalVAT: centsToDecimalString(t.vatCents), totalTTC: centsToDecimalString(t.ttcCents),
        notes: "Facture d'acompte : le solde sera facturé à l'issue des prestations, déduction faite du présent acompte.",
        lines: { create: lines.map((l, i) => ({ designation: depositDesignation(q.number, request, l.vatRateBp), unit: "forfait", quantity: "1.00", unitPrice: centsToDecimalString(l.netCents), vatRate: bpToPercentString(l.vatRateBp), lineHT: centsToDecimalString(l.netCents), discountBp: 0, position: i })) },
      },
      select: { id: true, number: true },
    })
    await tx.historyLog.create({ data: { companyId: ctx.companyId, worksiteId: q.worksiteId, actorId: ctx.userId, action: "CREATED", entityType: "Invoice", entityId: inv.id, detail: `Facture d'acompte ${inv.number} créée (brouillon) sur le devis ${q.number}`, newValue: { quoteId: q.id, totalTTC: centsToDecimalString(t.ttcCents) } } })
    await flushDeferredConstraints(tx)
    return { ok: true, value: { ...inv, ttcCents: t.ttcCents } }
  })
}

/** Acomptes émis (non annulés) d'un devis, avec leurs lignes par taux. */
export async function issuedDeposits(tx: Tx | Db, companyId: string, quoteId: string): Promise<IssuedDeposit[]> {
  const rows = await tx.invoice.findMany({
    where: { companyId, quoteId, kind: "DEPOSIT", status: { in: ["SENT", "PARTIAL", "PAID"] } }, orderBy: { issueDate: "asc" },
    select: { id: true, number: true, issueDate: true, lines: { select: { lineHT: true, vatRate: true } } },
  })
  return rows.map((d) => ({ id: d.id, number: d.number, issueDate: d.issueDate, lines: d.lines.map((l) => ({ vatRateBp: storedVatRateToBp(l.vatRate), netCents: decimalToCents(l.lineHT) })) }))
}

/**
 * Recalcule les déductions d'acomptes d'une facture de solde en brouillon (kind INVOICE, devis lié) :
 * supprime les lignes de déduction existantes et la liaison, recrée une ligne par acompte émis et par taux,
 * recalcule les totaux. Conditionnel sur DRAFT.
 */
async function lockInvoice(tx: Tx, invoiceId: string, companyId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "invoices" WHERE "id" = ${invoiceId} AND "companyId" = ${companyId} FOR UPDATE`
}

export async function applyDepositDeductionsCore(tx: Tx, ctx: DepositContext, finalInvoiceId: string): Promise<LifecycleResult<{ deposits: number; ttcCents: bigint }>> {
  await lockInvoice(tx, finalInvoiceId, ctx.companyId)
  const inv = await tx.invoice.findFirst({
    where: { id: finalInvoiceId, companyId: ctx.companyId },
    select: { id: true, status: true, kind: true, quoteId: true, number: true, worksiteId: true, globalDiscountBp: true, vatReverseCharge: true, lines: { orderBy: { position: "asc" }, select: { id: true, deductsDepositId: true, quantity: true, unitPrice: true, vatRate: true, discountBp: true } } },
  })
  if (!inv) return { ok: false, error: "Facture introuvable." }
  if (inv.status !== "DRAFT" || inv.kind !== "INVOICE" || !inv.quoteId) return { ok: false, error: DEPOSIT_ERRORS.notFinalDraft }
  const deposits = await issuedDeposits(tx, ctx.companyId, inv.quoteId)
  const keep = inv.lines.filter((l) => !l.deductsDepositId)
  const deductions = buildDeductionLines(deposits)
  // Même calcul qu'à l'émission (issueInvoiceCore) : les lignes de déduction sont hors remise globale.
  const all = computeDocumentTotals([
    ...keep.map((l) => ({ quantityHundredths: decimalToCents(l.quantity), unitPriceCents: decimalToCents(l.unitPrice), discountBp: l.discountBp, vatRateBp: storedVatRateToBp(l.vatRate) })),
    ...deductions.map((d) => ({ quantityHundredths: BigInt(100), unitPriceCents: d.unitPriceCents, discountBp: 0, vatRateBp: d.vatRateBp, excludeGlobalDiscount: true })),
  ], { globalDiscountBp: inv.globalDiscountBp, vatReverseCharge: inv.vatReverseCharge })
  const totalHT = all.totalHTCents, totalVAT = all.totalVATCents
  if (totalHT + totalVAT < BigInt(0)) return { ok: false, error: DEPOSIT_ERRORS.ceiling }
  const locked = await tx.invoice.updateMany({ where: { id: inv.id, companyId: ctx.companyId, status: "DRAFT", kind: "INVOICE" }, data: { totalHT: centsToDecimalString(totalHT), totalVAT: centsToDecimalString(totalVAT), totalTTC: centsToDecimalString(totalHT + totalVAT) } })
  if (locked.count !== 1) return { ok: false, error: DEPOSIT_ERRORS.notFinalDraft }
  await tx.invoiceLine.deleteMany({ where: { invoiceId: inv.id, deductsDepositId: { not: null } } })
  await tx.invoiceDepositDeduction.deleteMany({ where: { companyId: ctx.companyId, finalInvoiceId: inv.id } })
  let position = keep.length
  if (deductions.length) {
    await tx.invoiceLine.createMany({ data: deductions.map((d) => ({ invoiceId: inv.id, designation: d.designation, unit: "forfait", quantity: "1.00", unitPrice: centsToDecimalString(d.unitPriceCents), vatRate: bpToPercentString(d.vatRateBp), lineHT: centsToDecimalString(d.unitPriceCents), discountBp: 0, position: position++, deductsDepositId: d.deductsDepositId })) })
    await tx.invoiceDepositDeduction.createMany({ data: deposits.map((d) => ({ companyId: ctx.companyId, finalInvoiceId: inv.id, depositInvoiceId: d.id, amountTTCCents: d.lines.reduce((s, l) => s + l.netCents + (inv.vatReverseCharge ? BigInt(0) : vatCents(l.netCents, l.vatRateBp)), BigInt(0)) })) })
  }
  await tx.historyLog.create({ data: { companyId: ctx.companyId, worksiteId: inv.worksiteId, actorId: ctx.userId, action: "UPDATED", entityType: "Invoice", entityId: inv.id, detail: `Déductions d'acomptes recalculées sur ${inv.number} (${deposits.length} acompte${deposits.length > 1 ? "s" : ""})`, newValue: { deposits: deposits.map((d) => d.number), totalTTC: centsToDecimalString(totalHT + totalVAT) } } })
  return { ok: true, value: { deposits: deposits.length, ttcCents: totalHT + totalVAT } }
}

export async function applyDepositDeductions(db: Db, ctx: DepositContext, finalInvoiceId: string): Promise<LifecycleResult<{ deposits: number; ttcCents: bigint }>> {
  return db.$transaction(async (tx) => {
    const r = await applyDepositDeductionsCore(tx, ctx, finalInvoiceId)
    if (r.ok) await flushDeferredConstraints(tx)
    return r
  })
}

/**
 * Contrôles d'émission liés aux acomptes (appelés par issueInvoiceCore, sous verrou de la facture) :
 * - facture de solde (INVOICE + devis) : aucun acompte brouillon ; chaque acompte émis déduit exactement ;
 * - acompte (DEPOSIT) : plafond revérifié (Σ acomptes non annulés ≤ TTC du devis) sous verrou du devis.
 */
export async function depositIssueChecks(tx: Tx, companyId: string, invoice: { id: string; kind: string; quoteId: string | null; totalTTCCents: bigint; vatReverseCharge: boolean }): Promise<string | null> {
  if (!invoice.quoteId) return null
  if (invoice.kind === "INVOICE") {
    // ORDRE GLOBAL DES VERROUS (facturation) : FACTURE (lockInvoiceRow, premier) → DEVIS (lockQuoteRow) → ACOMPTES (FOR UPDATE).
    // issueInvoiceCore tient la facture avant d'appeler ces contrôles ; updateDraftInvoice verrouille la facture puis le devis ;
    // createDepositInvoice/convertQuote/createDraftInvoice ne tiennent aucune facture existante avant le devis. Aucun chemin ne prend devis → facture existante.
    // Même famille que R2 (audit A1) : verrou du devis AVANT les contrôles — la création d'un acompte (createDepositInvoice, qui
    // verrouille le devis puis vérifie « solde émis ») est sérialisée avec l'émission du solde : plus d'acompte créé pendant l'émission.
    await lockQuoteRow(tx, invoice.quoteId, companyId)
    // Verrou des acomptes du devis : sérialise avec un avoir total concurrent sur l'un d'eux (createCreditNoteCore).
    await tx.$queryRaw`SELECT 1 FROM "invoices" WHERE "companyId" = ${companyId} AND "quoteId" = ${invoice.quoteId} AND "kind"::text = 'DEPOSIT' ORDER BY "id" FOR UPDATE`
    const draft = await tx.invoice.count({ where: { companyId, quoteId: invoice.quoteId, kind: "DEPOSIT", status: "DRAFT" } })
    if (draft > 0) return DEPOSIT_ERRORS.depositDraft
    const deposits = await issuedDeposits(tx, companyId, invoice.quoteId)
    const flags = await tx.invoice.findMany({ where: { companyId, id: { in: deposits.map((d) => d.id) } }, select: { vatReverseCharge: true } })
    if (flags.some((f) => f.vatReverseCharge !== invoice.vatReverseCharge)) return "L'autoliquidation de la facture de solde doit être identique à celle des acomptes déduits."
    const deducted = await tx.invoiceDepositDeduction.findMany({ where: { companyId, finalInvoiceId: invoice.id }, select: { depositInvoiceId: true } })
    const deductedIds = new Set(deducted.map((d) => d.depositInvoiceId))
    if (deposits.some((d) => !deductedIds.has(d.id))) return DEPOSIT_ERRORS.depositNotDeducted
    if (deducted.some((d) => !deposits.find((x) => x.id === d.depositInvoiceId))) return DEPOSIT_ERRORS.deductionMismatch
    // Lignes de déduction = acomptes émis (par taux et montant).
    const lines = await tx.invoiceLine.findMany({ where: { invoiceId: invoice.id, deductsDepositId: { not: null } }, select: { deductsDepositId: true, vatRate: true, lineHT: true } })
    const expected = new Map<string, bigint>()
    for (const d of deposits) for (const l of d.lines) if (l.netCents !== BigInt(0)) expected.set(`${d.id}|${l.vatRateBp}`, (expected.get(`${d.id}|${l.vatRateBp}`) ?? BigInt(0)) - l.netCents)
    const actual = new Map<string, bigint>()
    for (const l of lines) { const k = `${l.deductsDepositId}|${storedVatRateToBp(l.vatRate)}`; actual.set(k, (actual.get(k) ?? BigInt(0)) + decimalToCents(l.lineHT)) }
    if (expected.size !== actual.size || [...expected].some(([k, v]) => actual.get(k) !== v)) return DEPOSIT_ERRORS.deductionMismatch
    return null
  }
  if (invoice.kind === "DEPOSIT") {
    await lockQuoteRow(tx, invoice.quoteId, companyId)
    const q = await tx.quote.findFirst({ where: { id: invoice.quoteId, companyId }, select: { totalTTC: true } })
    if (!q) return DEPOSIT_ERRORS.quoteNotFound
    // Audit A1 : un acompte ne s'émet jamais après l'émission de la facture de solde (il ne serait jamais déduit : double facturation).
    const finalIssued = await tx.invoice.findFirst({ where: { companyId, quoteId: invoice.quoteId, kind: "INVOICE", status: { in: ["SENT", "PARTIAL", "PAID"] } }, select: { id: true } })
    if (finalIssued) return DEPOSIT_ERRORS.finalIssued
    const others = await depositsTotalCents(tx, companyId, invoice.quoteId, invoice.id)
    if (others + invoice.totalTTCCents > decimalToCents(q.totalTTC)) return DEPOSIT_ERRORS.ceiling
  }
  return null
}

/** Acomptes d'un devis (tous statuts) pour l'affichage. */
export async function listQuoteDeposits(db: Db, companyId: string, quoteId: string) {
  const rows = await db.invoice.findMany({ where: { companyId, quoteId, kind: "DEPOSIT" }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true, issueDate: true, totalTTC: true, depositBp: true, payments: { select: { amountCents: true } } } })
  return rows.map((r) => ({ id: r.id, number: r.number, status: r.status, issueDate: r.issueDate, ttcCents: decimalToCents(r.totalTTC), paidCents: r.payments.reduce((s, p) => s + p.amountCents, BigInt(0)), depositBp: r.depositBp }))
}
