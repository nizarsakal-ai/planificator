// ═══════════════════════════════════════════════════════════════════════════
// Avoirs partiels — Lot C4 : création (verrou de la facture d'origine, plafond = TTC − Σ avoirs partiels émis),
// émission immédiate (série AV), recalcul du reste à payer et du statut de l'origine. L'avoir total reste le Lot B.
// ═══════════════════════════════════════════════════════════════════════════
import type { Prisma, PrismaClient } from "@prisma/client"
import { nextDocumentNumber } from "@/lib/billing/numbering"
import { flushDeferredConstraints } from "@/lib/deferred-constraints"
import { MoneyError, bpToPercentString, centsToDecimalString, decimalToCents, hundredthsToDecimalString, storedVatRateToBp } from "@/lib/billing/money"
import type { LifecycleResult } from "@/lib/billing/quotes/quote-lifecycle.core"
import { enablePaymentsContext, lockInvoiceRow } from "./invoice.service"
import { statusForPaid, sumPayments } from "./invoice-c2.core"
import { computeCreditLines, type CreditRequest } from "./credit-note.core"
import { captureDocumentSnapshot } from "@/lib/billing/pdf/document-snapshot"

type Db = PrismaClient
export interface CreditContext { companyId: string; userId: string }

export const CREDIT_ERRORS = {
  notFound: "Facture introuvable.",
  notCreditable: "Seule une facture émise (envoyée, partiellement ou totalement payée) peut faire l'objet d'un avoir.",
  isCreditNote: "Un avoir ne peut pas être crédité.",
  totalExists: "Cette facture est déjà annulée par un avoir total.",
  depositDeducted: "Cet acompte est déduit sur une facture de solde émise : établissez l'avoir sur la facture de solde.",
  depositPartial: "Un acompte ne reçoit pas d'avoir partiel (il est déduit en totalité sur la facture de solde) : utilisez l'avoir total.",
  exceeds: "L'avoir dépasse le montant restant créditable.",
  exceedsPaid: "L'avoir dépasse le reste à payer : contre-passez d'abord le paiement correspondant (aucun trop-perçu n'est créé par avoir).",
  settledOutside: "Facture réglée hors module (payée sans ligne de paiement enregistrée) : aucun avoir partiel possible, utilisez l'avoir total.",
  reason: "Indiquez le motif de l'avoir (3 caractères minimum).",
  invalid: "Lignes ou montant de l'avoir invalides.",
} as const

/** Σ TTC des avoirs partiels émis d'une facture (centimes). */
export async function creditedPartialCents(tx: Prisma.TransactionClient | Db, companyId: string, invoiceId: string): Promise<bigint> {
  const rows = await tx.invoice.findMany({ where: { companyId, creditedInvoiceId: invoiceId, kind: "CREDIT_NOTE", creditScope: "PARTIAL", status: { not: "CANCELLED" } }, select: { totalTTC: true } })
  return rows.reduce((s, r) => s + decimalToCents(r.totalTTC), BigInt(0))
}

export async function createPartialCreditNote(db: Db, ctx: CreditContext, invoiceId: string, request: CreditRequest, reason: string, now: Date): Promise<LifecycleResult<{ id: string; number: string; ttcCents: bigint; originStatus: string }>> {
  const motive = reason.trim().slice(0, 500)
  if (motive.length < 3) return { ok: false, error: CREDIT_ERRORS.reason }
  return db.$transaction(async (tx) => {
    await enablePaymentsContext(tx)
    await lockInvoiceRow(tx, invoiceId, ctx.companyId)
    const o = await tx.invoice.findFirst({
      where: { id: invoiceId, companyId: ctx.companyId },
      select: { id: true, number: true, status: true, kind: true, worksiteId: true, clientId: true, quoteId: true, periodStart: true, periodEnd: true, totalTTC: true, globalDiscountBp: true, vatReverseCharge: true, paymentTerms: true,
        lines: { orderBy: { position: "asc" }, select: { id: true, designation: true, description: true, unit: true, quantity: true, unitPrice: true, discountBp: true, vatRate: true, deductsDepositId: true } } },
    })
    if (!o) return { ok: false, error: CREDIT_ERRORS.notFound }
    if (o.kind === "CREDIT_NOTE") return { ok: false, error: CREDIT_ERRORS.isCreditNote }
    if (!["SENT", "PARTIAL", "PAID"].includes(o.status)) return { ok: false, error: CREDIT_ERRORS.notCreditable }
    const total = await tx.invoice.findFirst({ where: { companyId: ctx.companyId, creditedInvoiceId: o.id, kind: "CREDIT_NOTE", creditScope: "TOTAL" }, select: { id: true } })
    if (total) return { ok: false, error: CREDIT_ERRORS.totalExists }
    // Un acompte est déduit en totalité sur la facture de solde : un avoir partiel créerait un double crédit ⇒ avoir total seulement.
    if (o.kind === "DEPOSIT") return { ok: false, error: CREDIT_ERRORS.depositPartial }
    let computed
    try {
      computed = computeCreditLines({
        globalDiscountBp: o.globalDiscountBp, vatReverseCharge: o.vatReverseCharge,
        lines: o.lines.map((l) => ({ id: l.id, designation: l.designation, description: l.description, unit: l.unit, quantityHundredths: decimalToCents(l.quantity), unitPriceCents: decimalToCents(l.unitPrice), discountBp: l.discountBp, vatRateBp: storedVatRateToBp(l.vatRate), deductsDepositId: l.deductsDepositId })),
      }, request)
    } catch (e) { if (e instanceof MoneyError) return { ok: false, error: e.code === "CREDIT_EXCEEDS" ? CREDIT_ERRORS.exceeds : CREDIT_ERRORS.invalid }; throw e }
    const ttc = decimalToCents(o.totalTTC)
    const already = await creditedPartialCents(tx, ctx.companyId, o.id)
    if (already + computed.totals.totalTTCCents > ttc) return { ok: false, error: CREDIT_ERRORS.exceeds }
    // Règle unique (pas de trop-perçu par avoir) : avoir ≤ reste à payer = TTC − paiements − avoirs partiels.
    const paidBefore = await sumPayments(tx, ctx.companyId, o.id)
    // Correctif P1-07 : une facture PAID héritée (réglée hors module, sans ligne de paiement) est intégralement encaissée :
    // la tolérance « PAID sans paiement » n'est jamais un contournement du plafond (la base le refuse aussi).
    if (o.status === "PAID" && paidBefore === BigInt(0) && already === BigInt(0) && ttc > BigInt(0)) return { ok: false, error: CREDIT_ERRORS.settledOutside }
    if (paidBefore + already + computed.totals.totalTTCCents > ttc) return { ok: false, error: CREDIT_ERRORS.exceedsPaid }

    const number = await nextDocumentNumber(tx, ctx.companyId, "CREDIT_NOTE", now.getUTCFullYear())
    const note = await tx.invoice.create({
      data: {
        companyId: ctx.companyId, worksiteId: o.worksiteId, clientId: o.clientId, quoteId: o.quoteId, number, kind: "CREDIT_NOTE", creditScope: "PARTIAL", creditedInvoiceId: o.id, creditReason: motive,
        status: "DRAFT", issueDate: now, periodStart: o.periodStart, periodEnd: o.periodEnd, paymentTerms: o.paymentTerms,
        globalDiscountBp: request.kind === "LINES" ? o.globalDiscountBp : 0, vatReverseCharge: o.vatReverseCharge,
        totalHT: centsToDecimalString(computed.totals.totalHTCents), totalVAT: centsToDecimalString(computed.totals.totalVATCents), totalTTC: centsToDecimalString(computed.totals.totalTTCCents),
        notes: `Avoir partiel sur la facture ${o.number} — ${motive}`, createdById: ctx.userId,
        lines: { create: computed.lines.map((l, i) => ({ designation: l.designation, description: l.description, unit: l.unit, quantity: hundredthsToDecimalString(l.quantityHundredths), unitPrice: centsToDecimalString(l.unitPriceCents), vatRate: bpToPercentString(l.vatRateBp), lineHT: centsToDecimalString(computed.totals.lines[i].lineHTCents), discountBp: l.discountBp, position: i })) },
      },
      select: { id: true, number: true },
    })
    const issued = await tx.invoice.updateMany({ where: { id: note.id, companyId: ctx.companyId, status: "DRAFT", kind: "CREDIT_NOTE" }, data: { status: "SENT", sentAt: now } })
    if (issued.count !== 1) throw new Error("CREDIT_NOTE_ISSUE_FAILED")
    // Correctif P2-03 : l'avoir est une nouvelle pièce émise, à l'identité documentaire figée.
    await captureDocumentSnapshot(tx, ctx.companyId, note.id)

    // Reste à payer de l'origine = TTC − paiements − avoirs partiels ; soldée par avoir si reste = 0.
    const paid = paidBefore
    const remaining = ttc - paid - (already + computed.totals.totalTTCCents)
    let originStatus = o.status
    if (remaining <= BigInt(0) && (o.status === "SENT" || o.status === "PARTIAL")) {
      const u = await tx.invoice.updateMany({ where: { id: o.id, companyId: ctx.companyId, status: o.status }, data: { status: "PAID", paidAt: now } })
      if (u.count !== 1) throw new Error("INVOICE_STATUS_CONFLICT")
      originStatus = "PAID"
    }
    await tx.historyLog.create({ data: { companyId: ctx.companyId, worksiteId: o.worksiteId, actorId: ctx.userId, action: "CREATED", entityType: "CreditNote", entityId: note.id, detail: `Avoir partiel ${note.number} émis sur la facture ${o.number} (${centsToDecimalString(computed.totals.totalTTCCents)} € TTC) — ${motive}`, newValue: { creditedInvoiceId: o.id, totalTTC: centsToDecimalString(computed.totals.totalTTCCents) } } })
    if (originStatus !== o.status) {
      await tx.historyLog.create({ data: { companyId: ctx.companyId, worksiteId: o.worksiteId, actorId: ctx.userId, action: "STATUS_CHANGED", entityType: "Invoice", entityId: o.id, detail: `Facture ${o.number} soldée par avoir : ${o.status} → PAID`, oldValue: { status: o.status }, newValue: { status: "PAID", creditNoteId: note.id } } })
    }
    await flushDeferredConstraints(tx)
    return { ok: true, value: { id: note.id, number: note.number, ttcCents: computed.totals.totalTTCCents, originStatus } }
  })
}
