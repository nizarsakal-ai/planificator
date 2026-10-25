// TVA (SPEC-BILLING-C5 §3.3) : collectée sur les débits (pièces émises) ou les encaissements (paiements au prorata), déductible sur
// les factures fournisseurs validées. Tout en centimes ; société du contexte uniquement.
import type { Prisma, PrismaClient } from "@prisma/client"
import { computeDocumentTotals, decimalToCents, roundHalfUp, storedVatRateToBp } from "@/lib/billing/money"

type Db = PrismaClient | Prisma.TransactionClient
export interface VatRateRow { vatRateBp: number; baseCents: bigint; vatCents: bigint }
export interface VatComputation { basis: "DEBITS" | "ENCAISSEMENTS"; periodStart: Date; periodEnd: Date; collected: VatRateRow[]; collectedCents: bigint; deductibleCents: bigint; dueCents: bigint; documents: number; payments: number; supplierInvoices: number }

function addRow(map: Map<number, VatRateRow>, bp: number, base: bigint, vat: bigint) {
  const r = map.get(bp) ?? { vatRateBp: bp, baseCents: BigInt(0), vatCents: BigInt(0) }
  r.baseCents += base; r.vatCents += vat; map.set(bp, r)
}

const docSelect = { kind: true, globalDiscountBp: true, vatReverseCharge: true, totalTTC: true, lines: { select: { quantity: true, unitPrice: true, vatRate: true, discountBp: true, deductsDepositId: true } } } satisfies Prisma.InvoiceSelect
function docSummary(d: { kind: string; globalDiscountBp: number; vatReverseCharge: boolean; lines: { quantity: Prisma.Decimal; unitPrice: Prisma.Decimal; vatRate: Prisma.Decimal; discountBp: number; deductsDepositId: string | null }[] }) {
  const t = computeDocumentTotals(d.lines.map((l) => ({ quantityHundredths: decimalToCents(l.quantity), unitPriceCents: decimalToCents(l.unitPrice), discountBp: l.discountBp, vatRateBp: storedVatRateToBp(l.vatRate), excludeGlobalDiscount: !!l.deductsDepositId })), { globalDiscountBp: d.globalDiscountBp, vatReverseCharge: d.vatReverseCharge })
  const sign = d.kind === "CREDIT_NOTE" ? BigInt(-1) : BigInt(1)
  return { sign, totals: t }
}

export async function computeVat(db: Db, ctx: { companyId: string }, periodStart: Date, periodEnd: Date, basis: "DEBITS" | "ENCAISSEMENTS"): Promise<VatComputation> {
  const companyId = ctx.companyId
  const end = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate(), 23, 59, 59, 999))
  const map = new Map<number, VatRateRow>()
  let documents = 0, payments = 0
  if (basis === "DEBITS") {
    const docs = await db.invoice.findMany({ where: { companyId, status: { in: ["SENT", "PARTIAL", "PAID", "CANCELLED"] }, sentAt: { not: null }, issueDate: { gte: periodStart, lte: end } }, select: docSelect })
    for (const d of docs) { documents++; const { sign, totals } = docSummary(d); for (const v of totals.vatSummary) addRow(map, v.vatRateBp, sign * v.baseCents, sign * v.vatCents) }
  } else {
    // Avoirs émis sur la période : régularisation de la TVA collectée (montant négatif), quelle que soit la date d'encaissement.
    const notes = await db.invoice.findMany({ where: { companyId, kind: "CREDIT_NOTE", status: { in: ["SENT", "PAID"] }, sentAt: { not: null }, issueDate: { gte: periodStart, lte: end } }, select: docSelect })
    for (const d of notes) { documents++; const { sign, totals } = docSummary(d); for (const v of totals.vatSummary) addRow(map, v.vatRateBp, sign * v.baseCents, sign * v.vatCents) }
    const pays = await db.invoicePayment.findMany({ where: { companyId, paidAt: { gte: periodStart, lte: end } }, select: { amountCents: true, invoice: { select: docSelect } } })
    for (const p of pays) {
      payments++
      const { totals } = docSummary(p.invoice)
      const ttc = totals.totalTTCCents
      if (ttc <= BigInt(0)) continue
      // Part de TVA de chaque taux dans le paiement : paiement × TVA_taux / TTC (arrondi), base = paiement × base_taux / TTC.
      for (const v of totals.vatSummary) addRow(map, v.vatRateBp, roundHalfUp(p.amountCents * v.baseCents, ttc), roundHalfUp(p.amountCents * v.vatCents, ttc))
    }
  }
  const supplier = await db.supplierInvoice.findMany({ where: { companyId, status: "VALIDATED", date: { gte: periodStart, lte: end } }, select: { vatCents: true } })
  const deductible = supplier.reduce((s, r) => s + r.vatCents, BigInt(0))
  const collected = [...map.values()].sort((a, b) => a.vatRateBp - b.vatRateBp)
  const collectedCents = collected.reduce((s, r) => s + r.vatCents, BigInt(0))
  return { basis, periodStart, periodEnd, collected, collectedCents, deductibleCents: deductible, dueCents: collectedCents - deductible, documents, payments, supplierInvoices: supplier.length }
}
